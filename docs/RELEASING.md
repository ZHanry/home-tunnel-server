# Independent server releases

Published 5.0.0 artifacts remain in the original project. The first release from this
repository must use a new version greater than 5.0.0. Do not overwrite historical tags
or replace already distributed binaries.

## Release steps

1. Update this component's source version and changelog. Leave sibling component versions alone.
2. Update the compatibility record when new version pairs have passed integration tests.
3. Merge to `main` and wait for its **Quality Gate** and security checks to pass.
4. Tag that commit `vX.Y.Z-rc.N` and push the tag. `release.yml` builds the complete component
   matrix once, retaining existing checksums, SBOMs and signing/provenance steps.
5. Verify the published RC on supported real devices. Tag the exact same commit `vX.Y.Z`.
   Stable verifies the RC manifest's identity, revision and every asset checksum, then
   publishes those identical bytes. It does not rebuild or replace an existing release.

The aggregate checksum manifest is signed with GitHub OIDC. Verify it against this
repository's `release.yml` identity and the **RC tag** recorded in `release-manifest.json`,
including when downloading a stable release. Do not verify against the former monorepo
workflow identity for newly built artifacts.

Component versions are independent. API v1 is the current protocol boundary, not a
guarantee that arbitrary future versions interoperate. Record and test supported pairs.

## Server specifics

Keep the versions in both service package files and `control-center/src/version.ts`
aligned. Deployment defaults can continue to reference an accepted published baseline
until the next release is verified. Images retain the existing GHCR package names;
the server repository must have Actions write access to those packages.

Release candidates build both Linux architectures and run production-path integration
against the independently pinned client in `tests/client-baseline.json`. Stable releases
publish `compose.release.yaml` with exact image digests. Apply it together with the base
Compose file after reviewing upgrade notes. No floating image `latest` tag is required.

FRPS remains an independently pinned dependency. Do not overwrite its existing tag.
Use a new dependency revision and update the recorded digest when rebuilding it.
