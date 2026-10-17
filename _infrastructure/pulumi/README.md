# gha-microvm-runner infrastructure

Pulumi (TypeScript) for the AWS side of the MicroVM runner POC: VPC, API
Gateway, SQS, DynamoDB, Secrets Manager, KMS, both Lambdas, and the IAM roles
that hold it together.

## One stack, one account, no exceptions

This deploys to a stack named `sbx` in the one AWS account you set as
`awsAccountId`, and it refuses everything else. Wrong stack name, it throws.
Credentials that resolve to any other account, it throws during preview,
before anything gets created. That guard exists because a default AWS profile
pointed at prod is one typo away on every laptop, mine included.

Don't add stack files for other environments. This is a POC. It was never
meant to grow a prod stack, and the guard is there to make sure it doesn't.

## Running it

```bash
pulumi login
pulumi stack init <your-pulumi-org>/sbx   # first time only
pulumi stack select <your-pulumi-org>/sbx
pulumi preview --diff
pulumi up --diff
```

AWS credentials come from wherever you normally get them: a profile, an SSO
session, or the OIDC deploy role in CI. The account guard is what keeps the
wrong ones out.

## Config

`Pulumi.sbx.yaml` has the non-secret keys and the commands for the two
secrets (`webhookSecret`, `githubAppPrivateKey`). Optional keys:

| Key                        | Default | What it does                             |
| -------------------------- | ------- | ---------------------------------------- |
| `microvmImageIdentifier`   | unset   | Runner image ARN from the image build    |
| `vpcEnabled`               | `false` | VPC + NAT + flow logs (~$32/mo idle)     |
| `pulumiDeploymentsEnabled` | `false` | Pulumi Cloud deployment settings + drift |
| `datadogEnabled`           | `false` | Attach the Datadog Lambda layers         |
| `datadogApiKeySecretArn`   | unset   | Required once `datadogEnabled` is `true` |

`microvmImageIdentifier` is unset on the first deploy on purpose. The image
can't be built until this stack exists, and this stack can't point at an image
that doesn't exist yet. So the first `pulumi up` leaves it out, the dispatcher
fails loudly if a job shows up early, and you set it after the image build.
Then commit the stack file. CI only knows what's in git.
