# Source provenance

This repository is a product-only extraction. It does not replay the
experiment log history from the competition workspace.

## Pinned source

- Local original (read-only): `/home/alexey/git/agent-branches-integration`
- Source remote: `git@github.com:alexeygrigorev/cloudflare-agent-git.git`
- Source branch at extract time: `proto/integration-auth-matrix`
- Source commit: `db4f6a8c398d69f0e19072c41cb4b453b7dd1b71`
- Source tree: `f31c6865d278e75ac6445717813c41d21210ccb5`
- Committer date: `2026-10-04T04:00:44+02:00`
- Subject: merge: combine proto/sdk-get-task-auth (cbf72e2) into proto/integration-auth-matrix

Recover the original by checking out that commit in the source remote
or the preserved local worktree. Do not treat this private product repo
as a mirror of experiment history.

Selected product paths: **134**

| Path | Mode | Blob SHA |
| --- | --- | --- |
| `LICENSE` | `100644` | `f7531fe0b2d46fdd5a45de87558c477e340ca078` |
| `agent-branches` | `100755` | `b7efa8be78c9f3cc0cbe2ed00be64873e91dbe44` |
| `agent_branches/__init__.py` | `100644` | `d3b26a0acbe843d07787b15ddc561c1e4f12781a` |
| `agent_branches/__main__.py` | `100644` | `97cc83a646158579969a96a635b263bbab0ed1f0` |
| `agent_branches/cli.py` | `100644` | `3b0d935aeb2f5647d8932580993ba283865b2d45` |
| `agent_branches/client.py` | `100644` | `bd4b2e032350aa5d08a075e531dbe1a6cd03778a` |
| `agent_branches/git_utils.py` | `100644` | `1315f100f8e3be286474bd0a99eaa77dc9f62949` |
| `demo-target/README.md` | `100644` | `41798631eb60c9235687bd7eb88ecc708dbf50d9` |
| `demo-target/TASKS.md` | `100644` | `e0e05c04cdfd47ccc6f3080c26c9bdf7e9026a68` |
| `demo-target/package.json` | `100644` | `92f9079c725434aa18b5fc417069d96ad0e871b4` |
| `demo-target/src/shortlinks.js` | `100644` | `289b72dbb21af784f94ab56cd44507334be5b1a5` |
| `demo-target/src/store.js` | `100644` | `28dbbf39288a27f8362e174879968c751d1dcef0` |
| `demo-target/src/worker.js` | `100644` | `4d72d041cb47bf2429f6b88ce831e58703316d96` |
| `demo-target/test/_helpers.js` | `100644` | `46d8000846763267c760be9366c0833cc794e466` |
| `demo-target/test/create.test.js` | `100644` | `a946398f7d1487fd7e60f7fc6540a3a28cced885` |
| `demo-target/test/resolve.test.js` | `100644` | `3faa118fc60f9d65d39a74a0a5e12d99d5cab635` |
| `demo-target/test/routing.test.js` | `100644` | `2bf9b93377b3d0636ea0842b6b264aee8d63be84` |
| `demo-target/verify-overlap.sh` | `100755` | `63a47ecbc3efc9fc50ca402cff09835571a1cee2` |
| `demo-target/wrangler.toml` | `100644` | `f1257fc136e743e51e4f8e39e8eba6f3707033ad` |
| `live/.gitignore` | `100644` | `65b1ac3a625905a852ef312bf8336bfacaf19744` |
| `live/README.md` | `100644` | `278812c5a742dba7daec7e0140823f6e3f22c747` |
| `live/assertions.py` | `100644` | `375e783bf10b79cc3299e92294a39d5ee7fbb9d2` |
| `live/check-ui-pairs.cjs` | `100644` | `515a5a513f51531943e4d8fbc7a8570eb29bae96` |
| `live/run-demo.sh` | `100755` | `06ed5c4b194ccd38d39c7322d9219e41631afc49` |
| `live/sidecar.mjs` | `100755` | `d6acfa7f0ee68ae6276b82661786f10f6eb6bba1` |
| `prototype/.dev.vars.example` | `100644` | `bc427a54fa98ebad4bb7026d4d8e467da072218b` |
| `prototype/.gitignore` | `100644` | `418fac97126cdb398f1bed8367055338574242e7` |
| `prototype/ARCHITECTURE.md` | `100644` | `5c3e559eb983426b370ec8fa84765f1ec152e77c` |
| `prototype/CONTRACT.md` | `100644` | `51c2826d4f599738fafce2b79d85893fd3aeb538` |
| `prototype/README.md` | `100644` | `dd9ecaaa04a204465d3d6ac51284209b40a9fcb9` |
| `prototype/docs/best-practices.txt` | `100644` | `74d615ae8dc412f144af9eedc56f71f9c46941c8` |
| `prototype/docs/event-subscriptions.txt` | `100644` | `35a3b545933b5e2db89e076e84f31f6d30bdb8b2` |
| `prototype/docs/git-protocol.txt` | `100644` | `f9858897e0f67b827b13c13c6589eabe54457410` |
| `prototype/docs/limits.txt` | `100644` | `0f80d89720d9757fe32ab8cf04d1162f1d1a004a` |
| `prototype/docs/workers-binding.txt` | `100644` | `e5aecbce5e427f306ebfb72a059e8cfa16d6978f` |
| `prototype/local-artifacts/notify-hook.mjs` | `100644` | `963c0b17ff54718edf03d9ebeec3f17bed312664` |
| `prototype/local-artifacts/notify.test.mjs` | `100644` | `8206f873c73231d61ad60e490826f48404ad57bd` |
| `prototype/local-artifacts/sidecar.mjs` | `100644` | `5e079674219dd243e6d5117a51a46a5d01173e20` |
| `prototype/local-artifacts/sidecar.test.mjs` | `100644` | `7a6c94a4b0584bae6cc648f76b56c302ec42bac2` |
| `prototype/package-lock.json` | `100644` | `36d2449344a2caf18ab833e626be3a39c518eafe` |
| `prototype/package.json` | `100644` | `1ae4702822b68958544cd56874904f692c9697f4` |
| `prototype/src/artifacts/errors.ts` | `100644` | `76001b80a66cde166d7888d8c5187a8865c51108` |
| `prototype/src/artifacts/map.ts` | `100644` | `4a850ffc64dbf46b6d702b26f7284384df6edd7b` |
| `prototype/src/artifacts/real.ts` | `100644` | `38b73586167c0f90a4a5308bed1ce437eb7eb3c2` |
| `prototype/src/artifacts/rest.ts` | `100644` | `5ab1c30fa6f2db5c80a4ef3583e5111fca6acd50` |
| `prototype/src/artifacts/sidecar.ts` | `100644` | `ba24a745596b07417433b7c06253445e797f533c` |
| `prototype/src/checks-wire.ts` | `100644` | `339e71046794cf410ea8f9eed7c53a48c91dacad` |
| `prototype/src/cloudflare/coordinator-do.ts` | `100644` | `9b15da3b4080e2a677b5a04bdeb158562aaf8f39` |
| `prototype/src/cloudflare/do-store.ts` | `100644` | `6d9ee5137a62ce9ac29e30cb482256a87683a71a` |
| `prototype/src/cloudflare/env.ts` | `100644` | `8ffb5ece5d439168883d69f2107b63b10abc26cb` |
| `prototype/src/cloudflare/githost.ts` | `100644` | `e9ec3acf715df04a132e02daf8441bdd04a329f1` |
| `prototype/src/cloudflare/push-events.ts` | `100644` | `3d70380a33677b7438266f4dbe6e62120ebd41b9` |
| `prototype/src/cloudflare/worker.ts` | `100644` | `4a5fc0263b6ac841acfaabb8cf54603c84e0f364` |
| `prototype/src/coordinator.ts` | `100644` | `e5c0a171cbd36ee822ff76b64c85dadb98c4ae81` |
| `prototype/src/core/auth.ts` | `100644` | `5a98e44dd0a099f7b402833c1a8a7a413a060d6d` |
| `prototype/src/core/coordinator.ts` | `100644` | `99efb801dfdbc109075d4734175c889c1ad01ec2` |
| `prototype/src/core/model.ts` | `100644` | `ffe8679cb01bc3997f90e3f980a59a70935e9f67` |
| `prototype/src/core/router.ts` | `100644` | `4c296c8a472c4ee6b90308f8a2c70747a25844e8` |
| `prototype/src/index.ts` | `100644` | `dd7e6196d58b81aad3c195c71e4f8a9596e89816` |
| `prototype/src/local/githost.ts` | `100644` | `7fba91afca62698ce9920078fb26d37f931767a9` |
| `prototype/src/local/main.ts` | `100644` | `c65858137963726247e72d66133024c070daf1ff` |
| `prototype/src/local/node-globals.d.ts` | `100644` | `3d1e9eeb60849af86e824129ba94d69772613f15` |
| `prototype/src/local/push-events.ts` | `100644` | `39737ecbff4c9e0975cfde2b9e3df4863d9c58d2` |
| `prototype/src/local/runtime.ts` | `100644` | `215bc27716a7beb83d89eca36970c571d87df8c6` |
| `prototype/src/local/store.ts` | `100644` | `fe56694d91f0afce5695195163e557214263a484` |
| `prototype/src/ports/clock.ts` | `100644` | `a32e91111849b3b147b0ae59ba31359e9bd8d367` |
| `prototype/src/ports/coordination-store.ts` | `100644` | `f2aa925db8ad25e791bae0b0780890b9e8d28c00` |
| `prototype/src/ports/githost.ts` | `100644` | `804a8385c7114d821c2f70794d5817ccdb3a4540` |
| `prototype/src/ports/push-events.ts` | `100644` | `c0ff4c547fd9cebf5d14b692cad65d7a8067e388` |
| `prototype/src/radar.ts` | `100644` | `027677a0340ba6388fcc7f246b7e40ed2c68ef88` |
| `prototype/src/types.ts` | `100644` | `5fa50964e259043434d77b555b40740bd24034f8` |
| `prototype/test/auth.test.ts` | `100644` | `9d2c3b067b409cfd92fe33a90af91105c8e3ce1b` |
| `prototype/test/checks-wire.test.ts` | `100644` | `5e09d6579e31ae82c3d27a6df409abfaf98e9247` |
| `prototype/test/checks.test.ts` | `100644` | `9de73b7d458a6cff231783b4b8340d90db16822c` |
| `prototype/test/coordinator.test.ts` | `100644` | `f7365ec3ffcfc8d95a988b06c4f2503536ab1a8d` |
| `prototype/test/durable.test.ts` | `100644` | `3ed907cf9978a2f3f84d077e4de08cd5422e7ef2` |
| `prototype/test/env.d.ts` | `100644` | `6800a41da7eba2ba72f79a29d90d83aa0cb4d923` |
| `prototype/test/envelope.test.ts` | `100644` | `fb9e501a9fd54bc66e08f00540b02ecdb0c575dc` |
| `prototype/test/fixtures/artifacts-spike.ts` | `100644` | `fa39eb436be26a66f4b86fd2a51291b43e58cd0f` |
| `prototype/test/global-setup.ts` | `100644` | `7a1a4afd9639cf38c617cfdde0ddad55e6425dc6` |
| `prototype/test/helpers.ts` | `100644` | `b38680fede85343f4e2f209ce9b0d6a5df05532b` |
| `prototype/test/node/architecture.test.ts` | `100644` | `9b5d088efe12c934610bcaf937eaef2e8f5ca31e` |
| `prototype/test/node/core.test.ts` | `100644` | `1e5811592da6d040249b207d64ef1bd77f183279` |
| `prototype/test/node/fakes.ts` | `100644` | `59e9646693a6aecec479a5cc15ec6d5c34fddfac` |
| `prototype/test/node/local-runtime.test.ts` | `100644` | `0ceb7b952980c8ec2826fb0d12f12f96fa1881ee` |
| `prototype/test/node/router.test.ts` | `100644` | `478fd1369f687b4842f75f99215bf0de27885786` |
| `prototype/test/node/webhook-auth.test.ts` | `100644` | `69807cf6f5309e874cbeb12a387ac89b4327f465` |
| `prototype/test/provided.d.ts` | `100644` | `399304646fc1da2864039ae426afab70e07bfafb` |
| `prototype/test/radar.test.ts` | `100644` | `18b4fc1e3e420ce9e4458d046f0db340f79e37c0` |
| `prototype/test/real-artifacts.test.ts` | `100644` | `12bdd5b936534e6a91e1892072cc27dc094d9084` |
| `prototype/test/rest-client.test.ts` | `100644` | `9d90d93637f5a98e9e5a921b6ec4dc6a5212356b` |
| `prototype/test/spike-sidecar.test.ts` | `100644` | `cae8ca3f4d281ba08e69387d9784d53ad794b966` |
| `prototype/test/tasks.test.ts` | `100644` | `b0059340a0efbf80aa74a1f7e2ed332c812c918d` |
| `prototype/test/unprocessed.test.ts` | `100644` | `2627e03afd161738027b511fbaae8dab05f511b1` |
| `prototype/test/wire.test.ts` | `100644` | `798a067dd5b494a7811696d28ed0619881befe15` |
| `prototype/tsconfig.json` | `100644` | `f521df0c405635cc776fa6ef96537ac435235ddb` |
| `prototype/tsconfig.node.json` | `100644` | `63f6f3143040b4a382580924f32ad7d094c18476` |
| `prototype/types/node-web.d.ts` | `100644` | `0fe4b497920a6f82509bc92ea9c66e30c9043c54` |
| `prototype/ui/README-UI.md` | `100644` | `1c7c7ffe79f917012d9a37f8264e08fd0cd81c9e` |
| `prototype/ui/fixtures/lost-push-task-0007.json` | `100644` | `958404922ab6a75137c5bdb60cb116f5bb04aabf` |
| `prototype/ui/fixtures/lost-push-task-0008.json` | `100644` | `e8ea2e4b5e1b219dc83f2bc8e8f22034327a6cb9` |
| `prototype/ui/fixtures/lost-push-task-0009.json` | `100644` | `724853c412d0803e02b47bbbbdebdf6a9ff0d00e` |
| `prototype/ui/fixtures/semantic-task-s1.json` | `100644` | `cc1272fce2ae2bf3f7c361f3a5e30e4246aa48bb` |
| `prototype/ui/fixtures/semantic-task-s2.json` | `100644` | `d56bc4026e9a24317b313d8f3fa63222c366dac5` |
| `prototype/ui/fixtures/semantic-task-s3.json` | `100644` | `45da6ca6196173c4044e9c15afd94d0baab16be3` |
| `prototype/ui/fixtures/status-lost-push.json` | `100644` | `11998fbd8bce57fb2d61ae8cc44cf8beb2b02588` |
| `prototype/ui/fixtures/status-semantic.json` | `100644` | `14757468bf62d0639c6379c9f0193ae3d0480d69` |
| `prototype/ui/fixtures/status.json` | `100644` | `90a6f5e09f5301a0b74a84893c6dcfcb1e09acd6` |
| `prototype/ui/fixtures/task-0001.json` | `100644` | `c941f8a6f5100c03f35c0c7fd34befcae4e4f5c6` |
| `prototype/ui/fixtures/task-0002.json` | `100644` | `8c325152ff4181720ede563b49079709b65e2978` |
| `prototype/ui/fixtures/task-0003.json` | `100644` | `1bc0d0fcda5901a704a8ff8bb70f43967ecf2863` |
| `prototype/ui/index.html` | `100644` | `b221db00709e6f1df24dc5441d2798df59cd05d5` |
| `prototype/ui/package.json` | `100644` | `6d41956dfa11314bb95984fde8adc788d39f741a` |
| `prototype/ui/pair-status.js` | `100644` | `e5f63c899098b106eb1e64b0ff4674601907460f` |
| `prototype/ui/request-guard.js` | `100644` | `ff22478eec14f14707f88c2a5922b083dae092d6` |
| `prototype/ui/style.css` | `100644` | `6dd3ed338ee168e7fa9200690fb6622bce47375a` |
| `prototype/ui/task.html` | `100644` | `4e916d8864b94b1a1ed46baa10909e24768e8b1d` |
| `prototype/ui/tests/generation-guard.test.js` | `100644` | `01e4969ba915fb214d958e361ae74c09aed1a091` |
| `prototype/ui/tests/pair-status.test.js` | `100644` | `cc5da87f46b66d9239c0c11e9860aabbf8074d55` |
| `prototype/ui/tests/test_dom_negative_browser.py` | `100644` | `7affb7b4aa2ae32f401c502a707d30e9710e80eb` |
| `prototype/ui/tests/view-logic.test.js` | `100644` | `5907c83dd0f0ee2e4f0812b761fba2eda026da60` |
| `prototype/ui/ui.js` | `100644` | `dfe628435113420287fc8ce15d2c30ddd9caddac` |
| `prototype/ui/view-logic.js` | `100644` | `1d7e5a41d9ef1310e7802c47e617c815b134f66b` |
| `prototype/vitest.config.ts` | `100644` | `2c8ae4a4c77d8960fbd92bf8915a6f6521ba1c75` |
| `prototype/worker-configuration.d.ts` | `100644` | `0d216d5b3de9a872b7f15bb35dbd3232c7066957` |
| `prototype/wrangler.jsonc` | `100644` | `95096c4a1d7c72491e87b73b053e09eaca03f247` |
| `radar/__init__.py` | `100644` | `c58fe4f28f6381254dcdff1ff11dd16b50c555f7` |
| `radar/__main__.py` | `100644` | `bc6bb81f4b782b23ea9023ef27a6a0efe962267c` |
| `radar/admission.py` | `100644` | `942267199fab6f0b8319f6beddc478015d2dc77d` |
| `radar/engine.py` | `100644` | `1445a949ef06022c4e8432f1f1ae99a58af013e4` |
| `tests/mock_l1_server.py` | `100644` | `c8fa7b251e5cad3f1df0e755c58bebc87282aa6e` |
| `tests/test_admission.py` | `100644` | `be2fe8da6bacf9eff4a545c2a3acea841e3cb110` |
| `tests/test_client.py` | `100644` | `b76cb19d956c984bdcb588db70a835b6a3de9e34` |
| `tests/test_radar_engine.py` | `100644` | `05fc0262d4ebebedc2495deadeb851873770300b` |
