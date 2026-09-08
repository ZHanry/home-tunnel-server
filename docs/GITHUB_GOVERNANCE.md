# Repository maintenance

This repository owns the server component. CI and CodeQL are scoped to its sources.
Release tags require a passing Quality Gate on the same commit and promote signed RC bytes.
Keep release and protocol tags immutable; use a new version when changing a published artifact.

Signing credentials belong in a restricted GitHub environment. Android's `android-release`
environment is limited to `v*` tags and retains the original application identity.
Do not commit generated artifacts, signing stores or operator credentials.

The original hub retains existing Issues, historical Releases and the project website.
Component-specific issues and pull requests belong here. Public vulnerability reports
must use the private reporting channel described in `SECURITY.md`.
