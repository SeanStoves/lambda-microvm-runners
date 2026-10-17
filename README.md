# lambda-microvm-runners

> **Disclaimer:** this started life as an internal hackathon project. I had
> the idea the day after AWS released Lambda MicroVMs, but I didn't get to
> dig into it until the hackathon on July 3, 2026. That's when I sat down to
> find out three things: what GitHub Actions runners on it would actually look
> like, whether it was doable at all, and whether it made any sense on cost.
> During the research phase I found Luc van Donkersgoed's write-up (see
> [Credit](#credit)), and his pattern is the backbone of what's here. This is
> that code, cleaned up and sanitized for public release. Every account ID, org
> name, secret, and internal reference has been stripped or swapped for a
> placeholder. It's a proof of concept. Treat it like one.

Ephemeral self-hosted GitHub Actions runners on
[AWS Lambda MicroVMs](https://aws.amazon.com/lambda/). One job, one MicroVM,
then it kills itself. It's not a runner fleet, and it deploys to exactly one
sandbox account and refuses to go anywhere else.

## Wait, didn't you say self-hosted runners were a hard pass?

I did. A persistent runner agent on a box you care about is a rancor in your
own pit, and you're trusting it to only eat what you point at. That opinion
hasn't changed.

What changed is the pit. Every job here gets a brand new MicroVM built from a
known image, a JIT runner registration that's good for exactly one job, and
an execution role that can do almost nothing. When the job finishes, the VM
calls TerminateMicrovm on itself and it's gone. There's no long-lived agent,
no shared workspace, and nothing left behind for the next job to trip over.
If one gets poisoned, it poisons a VM that was going to be bulldozed in a few
minutes anyway.

## How it works

```
GitHub (workflow_job: queued, label "lambda-microvms")
        |
        v
API Gateway HTTP API
        |
        v
Webhook Lambda (Node 22, arm64)
  - checks the HMAC signature, drops anything that fails
  - only passes "queued" jobs with the "lambda-microvms" label, from the pinned repo
        |
        v
SQS WebhookQueue  --(maxReceiveCount 3)-->  DLQ (14d retention)
        |
        v
Dispatcher Lambda (Node 22, arm64)
  - dedupes the delivery with a DynamoDB conditional put
  - mints a GitHub App JWT, trades it for an installation token
  - asks GitHub for a JIT runner config (repo-level)
  - calls RunMicrovm
        |
        v
Runner MicroVM (custom image, built from a Dockerfile via CreateMicrovmImage)
  - lifecycle hook server (ready / run / terminate)
  - GitHub Actions runner + Node 24 + git
  - runs one job, then self-terminates
```

The webhook Lambda does as little as possible on purpose. GitHub wants an
answer fast, so it verifies, filters, drops a message on the queue, and gets
out of the way. All the slow stuff (secrets, JWTs, GitHub API calls, starting
a VM) lives in the dispatcher where SQS can retry it.

| Path                      | What lives there                                  |
| ------------------------- | ------------------------------------------------- |
| `src/webhook/`            | Webhook receiver Lambda                           |
| `src/dispatcher/`         | SQS consumer, launches one MicroVM per job        |
| `microvm/`                | Runner image: Dockerfile, lifecycle hooks, runner |
| `scripts/`                | Image build, plus the one-time IAM bootstrap      |
| `_infrastructure/pulumi/` | Pulumi (TypeScript) for everything on the AWS side |

## Standing it up

### What you need

- An AWS account you're fine treating as a sandbox, and admin creds for it
- A GitHub repo to run jobs in (your fork of this one works)
- A Pulumi Cloud account. The free tier is fine
- Node 22, the Pulumi CLI, the AWS CLI, `gh`, and `openssl`

### Steps

1. **Ask AWS for a RunMicrovm quota bump first.** The default TPS on new
   accounts is low, and it's the thing most likely to stall your demo.
   Request it before you need it, not on game day.

2. **Create a GitHub App** (Settings → Developer settings → GitHub Apps) and
   install it on the one repo that'll use these runners.
   - Repository permissions: **Administration: read & write** (that's what
     generate-jitconfig wants) and **Actions: read** (or GitHub won't let you
     subscribe to the event below)
   - Subscribe to the **Workflow job** event
   - There's no webhook URL yet. Uncheck **Active** under Webhook for now;
     you'll come back in step 8
   - Grab the client ID from the app page, the installation ID from the end
     of the installation's URL, and generate a private key

3. **Install deps and create the stack.** Everything Pulumi happens from
   `_infrastructure/pulumi`. The stack has to be named `sbx`; the program
   refuses anything else.

   ```bash
   cd _infrastructure/pulumi
   npm ci
   pulumi login
   pulumi stack init <your-pulumi-org>/sbx
   ```

4. **Fill in `Pulumi.sbx.yaml`.** Region, account ID, Pulumi org, GitHub
   org/repo, and the app's client and installation IDs. `service`, `team`,
   and `teamSlack` are only tags, so put whatever you want there. Then the two
   secrets:

   ```bash
   pulumi config set --secret webhookSecret "$(openssl rand -hex 32)"
   pulumi config set --secret githubAppPrivateKey < ~/Downloads/your-app.private-key.pem
   ```

   Once that's in, delete the `.pem`. `*.pem` is gitignored, but there's no
   reason to keep it lying around.

5. **Bootstrap the CI roles.** From the repo root, with your own admin creds,
   once:

   ```bash
   scripts/bootstrap-roles.sh <github-org> <github-repo> <aws-account-id>
   ```

   That makes the GitHub OIDC provider (if you don't have one), a deploy role
   that only `main` can assume, and a read-only preview role that only PRs can
   assume. Run it before the first `pulumi up`, because the stack looks up
   that OIDC provider and fails if it isn't there. It's deliberately not part
   of the Pulumi stack; a stack shouldn't be able to hand itself the keys to
   itself. Read the script before you run it. Deploy gets AdministratorAccess,
   which is fine for a sandbox and not fine anywhere else.

6. **First `pulumi up`, by hand,** from `_infrastructure/pulumi` with the same
   admin creds:

   ```bash
   pulumi up --diff
   ```

   The dispatcher deploys without a runner image on purpose. That comes next.

7. **Set the repo variables, build the image, deploy again.** Still in
   `_infrastructure/pulumi`:

   ```bash
   gh variable set AWS_REGION --body "$(pulumi config get aws:region)"
   gh variable set AWS_ACCOUNT_ID --body "$(pulumi config get awsAccountId)"
   gh variable set AWS_ROLE_ARN --body "$(pulumi stack output githubOidcRoleArn)"
   gh variable set MICROVM_CODE_BUCKET --body "$(pulumi stack output microvmCodeBucket)"
   gh variable set MICROVM_BUILD_ROLE_ARN --body "$(pulumi stack output microvmBuildRoleArn)"
   gh variable set PULUMI_ORG --body "<your-pulumi-org>"
   gh variable set AWS_DEPLOY_ROLE_ARN --body "<printed by bootstrap-roles.sh>"
   gh variable set AWS_PREVIEW_ROLE_ARN --body "<printed by bootstrap-roles.sh>"
   gh secret set PULUMI_ACCESS_TOKEN
   ```

   Then run **Build MicroVM Image** from the Actions tab. It takes a while.
   The image ARN is the last line of the "Build MicroVM image" step's log.

   ```bash
   pulumi config set microvmImageIdentifier <that-arn>
   pulumi up --diff
   git add Pulumi.sbx.yaml && git commit -m "Point dispatcher at runner image" && git push
   ```

   **Commit that file.** CI deploys from what's in git. If the image ARN only
   lives on your laptop, the next deploy from main quietly unsets it and
   nothing dispatches. Once it's pushed, set `DEPLOY_ENABLED` to `true` if you
   want pushes to main to run `pulumi up` from here on.

8. **Turn the webhook on.** Back in the GitHub App, check **Active**, set the
   URL to the `webhookUrl` output, and paste in the secret. You never saw the
   secret because `openssl` generated it inline, so pull it back out:

   ```bash
   pulumi stack output webhookUrl
   pulumi config get webhookSecret
   ```

9. **Run the Demo workflow** from the Actions tab. If it picks up a runner and
   prints `success`, the whole chain works: webhook, queue, dispatcher,
   MicroVM, job. If it sits queued, check the app's Advanced tab for failed
   deliveries, then the webhook Lambda logs, then the dispatcher's.

### Repo variables and secrets

| Name                     | Kind     | Value                                        |
| ------------------------ | -------- | -------------------------------------------- |
| `AWS_REGION`             | variable | Region you deployed to                       |
| `AWS_ACCOUNT_ID`         | variable | Sandbox account ID (image build guard)       |
| `AWS_ROLE_ARN`           | variable | `githubOidcRoleArn` stack output             |
| `AWS_DEPLOY_ROLE_ARN`    | variable | Printed by `bootstrap-roles.sh`              |
| `AWS_PREVIEW_ROLE_ARN`   | variable | Printed by `bootstrap-roles.sh`              |
| `MICROVM_CODE_BUCKET`    | variable | `microvmCodeBucket` stack output             |
| `MICROVM_BUILD_ROLE_ARN` | variable | `microvmBuildRoleArn` stack output           |
| `PULUMI_ORG`             | variable | Your Pulumi Cloud org (or username)          |
| `DEPLOY_ENABLED`         | variable | `true` to let pushes to main run `pulumi up` |
| `PULUMI_ACCESS_TOKEN`    | secret   | Pulumi Cloud access token                    |

PR previews skip themselves until `AWS_PREVIEW_ROLE_ARN` is set, so a fresh
fork doesn't go red on its first PR.

### Tearing it down

```bash
cd _infrastructure/pulumi
pulumi destroy
```

That gets everything Pulumi made. Two things it doesn't know about: the
MicroVM images (the build script creates those with the SDK, so delete them
in the console or with the CLI, they're tagged `Project: lambda-microvm-runners`) and the
`/aws/microvm/gha-runner` log group the VMs create. The IAM roles from
`bootstrap-roles.sh` stay too, which is the point.

## Layers, each dumb on its own

None of this is clever. It's a handful of boring checks stacked so that
beating one doesn't buy you much.

- **The webhook drops what it can't verify.** Bad or missing HMAC signature
  is a 401. Wrong repo, wrong label, or anything but `queued` gets ignored.
- **The dispatcher dedupes.** GitHub retries and SQS redelivers. A DynamoDB
  conditional put means one delivery starts one VM, not three.
- **The runner registration is single-use.** A JIT config registers one
  ephemeral runner for one job. Stealing it gets you one job you were going
  to run anyway.
- **The VM's execution role is a broom closet.** It can terminate MicroVMs and
  write to its own log group. That's the list.
- **Credentials get stripped before the job starts.** The hook server
  removes the AWS credential env vars before it spawns the runner.
- **The stack refuses to deploy anywhere but the one account you configured.**
  Wrong stack name or wrong account ID and the program throws before it
  touches anything.
- **PR previews get read-only creds.** `pulumi preview` runs whatever Pulumi
  code is in the PR, so it gets a role that can look and can't touch. Only
  `main` can assume the deploy role.

## So what can a poisoned job actually do?

Plainly: run for up to an hour in a throwaway VM with outbound internet,
call TerminateMicrovm, and write logs. It can't read the dispatcher's
secrets or the GitHub App key. When the job ends, the VM ends with it.

Here's where I'm not going to pretend it's airtight. The job and the hook
server run as the same UID, so a job that goes looking can read the hook
server's environment out of `/proc` and get its AWS credentials. Those creds
are the broom-closet role above, so the damage is small, but it's a real gap
and the fix (a separate UID for the job, or dropping creds once they're not
needed) hasn't been written yet.

And the big one: **don't point this at a public repo without approval
gating.** Anyone who can open a PR can write a workflow with
`runs-on: [self-hosted, lambda-microvms]`, and on a public repo that's
everyone. Under *Settings → Actions → General*, find the fork pull request
approval setting and make it require approval for everyone outside the repo,
not just first-timers. The VM is disposable, but your AWS bill isn't.

## Things that'll bite you

- **arm64 only.** Both Lambdas and the runner image are arm64. The image
  build workflow runs on `ubuntu-24.04-arm` so the Docker context matches.
- **No VPC by default.** The Lambdas only talk to public GitHub and AWS APIs,
  so a VPC buys nothing except a NAT gateway billing you ~$32/month to sit
  idle. Idle cost with it off is basically zero: no NAT, no EIP, pay-per-request
  DynamoDB, and Lambdas that only run when a job shows up. Set
  `vpcEnabled: "true"` if your org requires VPC flow logs on everything.
- **Region.** Everything follows `aws:region` / `AWS_REGION`. I only ever ran
  it in us-east-1, so if MicroVMs aren't in your region yet, that's where it'll
  break.
- **`pulumi destroy` then `pulumi up` works.** The secrets skip the 30 day
  recovery window so their names free up right away, and the code bucket
  empties itself on destroy. Both are sandbox choices. Put them back before
  you trust anything real to this.
- **The RunMicrovm quota.** Yes, again. If the dispatcher logs are full of
  throttling errors, that's what it is.
- **`MICROVM-API` comments are guesses.** The IAM action names, ARN formats,
  and network connector IDs flagged with `MICROVM-API` in the code were
  inferred from the SDK and trial and error, not from published docs. Some
  of them got confirmed the hard way. Some didn't.
- **Pulumi Cloud Deployments and drift detection are off by default**
  (`pulumiDeploymentsEnabled`). They need a paid Pulumi tier.

## Credit

I found Luc's work during the research phase of the hackathon. The
architecture comes from Luc van Donkersgoed's
[GitHub Runner Orchestrator](https://github.com/donkersgoed/github-runner-ochestrator)
and his write-up,
["I replaced my GitHub runners with Lambda MicroVMs, and maybe you should too"](https://lucvandonkersgoed.com/2026/07/01/i-replaced-my-github-runners-with-lambda-microvms-and-maybe-you-should-too/).
This is a reimplementation of the same pattern with Pulumi instead of CDK and
a DynamoDB dedupe table, not a copy of his code. Go read his post.
