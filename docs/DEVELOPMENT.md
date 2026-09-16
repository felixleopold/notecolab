# Developing NoteColab

Use Node.js 22 and npm. The public repository keeps the Obsidian plugin at its
root, with the API in `api/` and the Nuxt web app in `web/`. Each has its own
package and lockfile.

```sh
git clone https://github.com/felixleopold/notecolab.git
cd notecolab
npm ci
npm test
npx tsc --noEmit
npm run build
```

Install `main.js` and `manifest.json` into a disposable vault's
`.obsidian/plugins/notecolab/` directory. Preserve its `data.json` when updating
the build. Never test synchronization against a primary vault.

For the API, run `npm ci`, `npm test`, and `npm run build` from `api/`. Set
`DATABASE_PATH` to a disposable SQLite file and `PORT` to a free port before
running `npm run dev`. Configure registration and CORS for your test environment.
Do not use hosted accounts for exploratory tests.

For the web app, run `npm ci`, `npm test`, `npm run typecheck`, and `npm run build`
from `web/`. Set `NUXT_PUBLIC_API_URL` to your isolated API origin for
`npm run dev`. Browser editor regression tests run with `npm run test:editor`
after installing Playwright's Chromium browser.

See [self-hosting](SELF-HOSTING.md) for the portable Docker Compose deployment,
[the protocol](PROTOCOL.md) for client/server compatibility, and
[the security model](../SECURITY-CONSIDERATIONS.md) before changing authentication,
encryption, access permissions, storage, or billing.

## Contributing

Open an issue with reproduction steps, versions, and the affected access mode.
Keep private notes, complete share URLs, API keys, and credentials out of reports.
Security reports follow [SECURITY.md](../SECURITY.md).

For a change, include a focused regression test where it protects meaningful
behavior. Verify both the owner and recipient when changing sharing. For
collaboration changes, exercise delayed peer updates and the Obsidian vault
bridge, not only an isolated editor. Check web changes at desktop and mobile
widths and plugin changes in a disposable vault.

The public repository is a clean export of application source. Operational data,
credentials, and private development history are not included. Source publication,
Obsidian releases, and hosted deployments are separate operations.
