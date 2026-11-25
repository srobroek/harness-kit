## [1.11.0](https://github.com/srobroek/harness-kit/compare/v1.10.1...v1.11.0) (2026-11-25)

### Features

* **pi:** put rules in a per-package prompt section and deliver globs rules with matching files ([f7e2436](https://github.com/srobroek/harness-kit/commit/f7e2436a10e632096e9349b1cc4a5ee2c9cf21e4))

## [1.10.1](https://github.com/srobroek/harness-kit/compare/v1.10.0...v1.10.1) (2026-11-24)

### Bug Fixes

* **mcp:** type empty required-environment lists in generated pi MCP servers ([fe553a5](https://github.com/srobroek/harness-kit/commit/fe553a5681134205157ccbdb31630e7e749bc981))

## [1.10.0](https://github.com/srobroek/harness-kit/compare/v1.9.0...v1.10.0) (2026-11-24)

### Features

* **mcp:** generate per-harness server declarations ([#25](https://github.com/srobroek/harness-kit/issues/25)) ([db72576](https://github.com/srobroek/harness-kit/commit/db7257629672d47dfa5d543f7e2b2ae861c5102c))

## [1.9.0](https://github.com/srobroek/harness-kit/compare/v1.8.0...v1.9.0) (2026-11-23)

### Features

* **pi:** declare companion pi packages and check that they are installed ([be9760a](https://github.com/srobroek/harness-kit/commit/be9760ab863ef17bd0a3e7f118ba83b49b270240))
* **pi:** list npm prerequisites as dependencies of published pi packages ([2d40f61](https://github.com/srobroek/harness-kit/commit/2d40f615f541c5e34e3eb92bca599e1015464844))
* **pi:** name pi packages with piPrefix and a per-plugin piName ([505ca1c](https://github.com/srobroek/harness-kit/commit/505ca1c9caa242ac7424eab36191b0e019d16b04))
* **pi:** publish pi packages to npm through trusted publishing ([a9677d2](https://github.com/srobroek/harness-kit/commit/a9677d24567ab5f722fda9c683ac224c86f16cf9))
* **prerequisites:** declare the CLIs a plugin needs and check them in pi and OMP ([171a19c](https://github.com/srobroek/harness-kit/commit/171a19c241ef299add0b540a0c5982f6e17f03d0))

### Bug Fixes

* **pi:** give a manifest without resource keys an empty extensions list ([f43349b](https://github.com/srobroek/harness-kit/commit/f43349b647485a3d3afd10c8a15b2a95cd7b2078))

## [1.8.0](https://github.com/srobroek/harness-kit/compare/v1.7.0...v1.8.0) (2026-11-23)

### Features

* **pi:** add a pi harness target ([51bec54](https://github.com/srobroek/harness-kit/commit/51bec54f65dc21fd089c3e202640e4605602d32f))
* **pi:** enforce OMP rule triggers and refuse agents without tools ([bd41712](https://github.com/srobroek/harness-kit/commit/bd41712ab0134255d1d4e5e796027dc7e2ba621e))

### Bug Fixes

* **pi:** treat a missing interruptMode as always, as OMP does ([3a7b373](https://github.com/srobroek/harness-kit/commit/3a7b373c5d2cfad6a1e654a617f94ac040f90cb0))

## [1.7.0](https://github.com/srobroek/harness-kit/compare/v1.6.0...v1.7.0) (2026-11-22)

### Features

* **renovate:** automerge patch, digest, pin and security updates once CI passes ([5b34888](https://github.com/srobroek/harness-kit/commit/5b34888a3d087809f87116281442401ff4ece1be))

## [1.6.0](https://github.com/srobroek/harness-kit/compare/v1.5.0...v1.6.0) (2026-11-22)

### Features

* pick bun or npm from the lockfile, add just recipes and mise pins ([327066d](https://github.com/srobroek/harness-kit/commit/327066d0fc62d2720f711bca884ab11142c5ef68))

## [1.5.0](https://github.com/srobroek/harness-kit/compare/v1.4.0...v1.5.0) (2026-11-21)

### Features

* switch tooling to bun and add just ([#17](https://github.com/srobroek/harness-kit/issues/17)) ([91acd67](https://github.com/srobroek/harness-kit/commit/91acd676931e5d0f356c45e7d87b0ab12e5c72ad))

## [1.4.0](https://github.com/srobroek/harness-kit/compare/v1.3.2...v1.4.0) (2026-11-20)

### Features

* Claude dependencies and links, releaseRules in the release preset ([2d85cae](https://github.com/srobroek/harness-kit/commit/2d85cae659c58fd4ca4be65ec9018d9c2b3ed77c))

## [1.3.2](https://github.com/srobroek/harness-kit/compare/v1.3.1...v1.3.2) (2026-11-20)

### Bug Fixes

* omit the "." export from a TUI-only OpenCode package ([682456a](https://github.com/srobroek/harness-kit/commit/682456ac504a51e9f550581813c941c6524e3a1e))

## [1.3.1](https://github.com/srobroek/harness-kit/compare/v1.3.0...v1.3.1) (2026-11-20)

### Bug Fixes

* **build:** preserve the executable bit when copying common files ([5e7928a](https://github.com/srobroek/harness-kit/commit/5e7928a01341c964f6f17a294050a143e10fb878))

## [1.3.0](https://github.com/srobroek/harness-kit/compare/v1.2.0...v1.3.0) (2026-11-20)

### Features

* owner-wins mode for registerAgents ([685b549](https://github.com/srobroek/harness-kit/commit/685b5491908ba4c89c3cef3b591df5ea6ed97d3f))

## [1.2.0](https://github.com/srobroek/harness-kit/compare/v1.1.0...v1.2.0) (2026-11-20)

### Features

* repo-level shared items and agent registration that skips duplicates ([c2fb2ed](https://github.com/srobroek/harness-kit/commit/c2fb2ed7a1fba33b30b373e3e3d967268bb27dc7))

## [1.1.0](https://github.com/srobroek/harness-kit/compare/v1.0.1...v1.1.0) (2026-11-20)

### Features

* vendor runtime modules into harness trees ([21a0fdf](https://github.com/srobroek/harness-kit/commit/21a0fdf574c0b8fbd0cad61b0ac67313eed46875))

## [1.0.1](https://github.com/srobroek/harness-kit/compare/v1.0.0...v1.0.1) (2026-11-20)

### Bug Fixes

* declare @visulima/yaml as a peer; the Renovate preset extends config:recommended ([41cc6bc](https://github.com/srobroek/harness-kit/commit/41cc6bca387de06de27b052e5638535fee57e823))

## 1.0.0 (2026-11-20)

### Features

* harness-kit CLI, config, presets and reusable workflows ([dcc53bc](https://github.com/srobroek/harness-kit/commit/dcc53bc186eff084fc31651675e4835d26760ce9))

### Bug Fixes

* pack-check falls back to /tmp when TMPDIR is unset ([4ae6d41](https://github.com/srobroek/harness-kit/commit/4ae6d413a73b9e765d1b49d39763b8e9072ea03e))
