#!/usr/bin/env bash
###
# bootstrap-roles.sh - one-time IAM setup so GitHub Actions can run Pulumi
# Author: Sean Stoves
#
# Creates, or updates if they're already there:
#   - the token.actions.githubusercontent.com OIDC provider
#   - gha-microvm-deploy   pulumi up, main branch only, AdministratorAccess
#   - gha-microvm-preview  pulumi preview, PRs only, ReadOnlyAccess
#
# Yes, deploy gets admin. This stack creates IAM roles, KMS keys, a VPC, and
# Lambdas, and a hand-scoped policy for all of that is its own project. It's a
# sandbox account. Don't run this anywhere you'd mind.
#
# Run it with your own admin creds, once, before the first CI run.
###
set -euo pipefail

OIDC_HOST="token.actions.githubusercontent.com"
DEPLOY_ROLE="gha-microvm-deploy"
PREVIEW_ROLE="gha-microvm-preview"

###
# Help Syntax Function
###
usage() {
    echo "Usage: $0 <github-org> <github-repo> <aws-account-id>"
    echo "  e.g. $0 my-org lambda-microvm-runners 123456789012"
    exit 1
}

###
# Trust policy: only GitHub's OIDC, only this repo, only this one sub claim
###
trust_policy() {
    local SUB="$1"
    cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "Federated": "${PROVIDER_ARN}" },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "${OIDC_HOST}:aud": "sts.amazonaws.com",
          "${OIDC_HOST}:sub": "${SUB}"
        }
      }
    }
  ]
}
EOF
}

###
# OIDC provider. One per account, so reuse it if it's already there
###
ensure_oidc_provider() {
    if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$PROVIDER_ARN" >/dev/null 2>&1; then
        echo "OIDC provider already exists, leaving it alone"
        return
    fi
    echo "Creating OIDC provider for ${OIDC_HOST}"
    aws iam create-open-id-connect-provider \
        --url "https://${OIDC_HOST}" \
        --client-id-list sts.amazonaws.com >/dev/null
}

###
# Create the role, or reset its trust policy if it exists, then attach the policy
###
ensure_role() {
    local NAME="$1" SUB="$2" POLICY_ARN="$3"
    local DOC
    DOC=$(trust_policy "$SUB")

    if aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
        echo "Role ${NAME} exists, resetting trust policy"
        aws iam update-assume-role-policy --role-name "$NAME" --policy-document "$DOC"
    else
        echo "Creating role ${NAME}"
        aws iam create-role --role-name "$NAME" --assume-role-policy-document "$DOC" \
            --description "GitHub Actions ${SUB}" >/dev/null
    fi
    aws iam attach-role-policy --role-name "$NAME" --policy-arn "$POLICY_ARN"
}

###
# Main
###
[ $# -eq 3 ] || usage
GH_ORG="$1"
GH_REPO="$2"
ACCOUNT_ID="$3"

# these go straight into a JSON trust policy, so nothing that could break out of a string
if ! [[ "$GH_ORG" =~ ^[A-Za-z0-9_.-]+$ && "$GH_REPO" =~ ^[A-Za-z0-9_.-]+$ ]]; then
    echo "Org and repo can only be letters, numbers, dot, dash, underscore" >&2
    exit 1
fi
if ! [[ "$ACCOUNT_ID" =~ ^[0-9]{12}$ ]]; then
    echo "Account ID should be 12 digits, got: ${ACCOUNT_ID}" >&2
    exit 1
fi

# same guard as the Pulumi program: wrong account, we touch nothing
CALLER_ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
if [ "$CALLER_ACCOUNT" != "$ACCOUNT_ID" ]; then
    echo "Your creds are for ${CALLER_ACCOUNT}, not ${ACCOUNT_ID}. Not touching it." >&2
    exit 1
fi

PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${OIDC_HOST}"

ensure_oidc_provider
ensure_role "$DEPLOY_ROLE" "repo:${GH_ORG}/${GH_REPO}:ref:refs/heads/main" \
    "arn:aws:iam::aws:policy/AdministratorAccess"
ensure_role "$PREVIEW_ROLE" "repo:${GH_ORG}/${GH_REPO}:pull_request" \
    "arn:aws:iam::aws:policy/ReadOnlyAccess"

echo
echo "Done. Set these as repo variables:"
echo "  AWS_DEPLOY_ROLE_ARN  = arn:aws:iam::${ACCOUNT_ID}:role/${DEPLOY_ROLE}"
echo "  AWS_PREVIEW_ROLE_ARN = arn:aws:iam::${ACCOUNT_ID}:role/${PREVIEW_ROLE}"
