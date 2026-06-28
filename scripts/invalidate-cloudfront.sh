#!/usr/bin/env bash
#
# Invalidate the CloudFront cache for this app's update feed after publishing, so
# clients see the new latest*.yml immediately instead of a cached copy.
#
# Credentials come from the ambient AWS environment (AWS_PROFILE locally, or
# AWS_ACCESS_KEY_ID/SECRET in CI). Overridable:
#   CF_DISTRIBUTION_ID   CloudFront distribution (default: the update.szalay.me dist)
#   CF_INVALIDATION_PATHS  space-separated paths (default: this app's prefix)
#
# The IAM principal needs cloudfront:CreateInvalidation on the distribution.
set -euo pipefail

DIST_ID="${CF_DISTRIBUTION_ID:-E6428K3WFUDSE}"      # alias update.szalay.me
PATHS="${CF_INVALIDATION_PATHS:-/pdf-qa/*}"          # wildcard = 1 billable path

echo "==> CloudFront invalidation: dist=$DIST_ID paths=$PATHS"
aws cloudfront create-invalidation \
  --distribution-id "$DIST_ID" \
  --paths $PATHS \
  --query "Invalidation.{Id:Id,Status:Status}" \
  --output table
echo "==> Invalidation submitted (propagates in ~1-2 min)."
