# Atlas

Atlas is an Electron-based AI coding workspace with an integrated editor, terminal, chat agent, and secure API proxy support.

## Highlights

- Multi-model AI assistant with tool execution workflows
- Built-in Monaco editor and terminal
- Chat threads, snapshots, and planning mode
- Cloudflare Worker proxy option for secure key handling
- Windows packaging with `electron-builder` (`.exe` installer + `.zip`)

## Project Structure

- `src/` — Electron app (main, preload, renderer, API clients)
- `worker/` — Cloudflare Worker proxy and deployment config
- `scripts/` — utility scripts (server, icon generation, mocks)
- `assets/` — icons and static resources

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- Windows (primary packaging target)

### Install

```bash
npm install
```

### Run (development)

```bash
npm run dev
```

### Build (Windows)

```bash
npm run build
```

Build output is generated in `dist/`.

## Security

- Do **not** commit `.env` files or secrets
- Use the Worker proxy for production API key protection
- Review `SECURITY.md` and `SECURITY_BEST_PRACTICES.md`

## Documentation

- `SIMPLE_GUIDE.md`
- `API_KEY_SETUP.md`
- `WORKER_SETUP.md`
- `INTEGRATION_GUIDE.md`
- `TEST_WITH_MOCK_API.md`
- `NEXT_STEPS.md`

## Contributing

Please read `CONTRIBUTING.md` before opening issues or pull requests.

## License

This project is licensed under the MIT License. See `LICENSE`.
