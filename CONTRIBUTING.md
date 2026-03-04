# Contributing to Atlas

Thanks for contributing.

## Workflow

1. Fork the repository
2. Create a feature branch
3. Make focused changes
4. Test locally
5. Open a pull request

## Development Setup

```bash
npm install
npm run dev
```

## Coding Guidelines

- Keep changes focused and minimal
- Follow existing code style in `src/`
- Avoid unrelated refactors in feature/fix PRs
- Never commit secrets, tokens, or `.env` values

## Commit Style

Use clear commit messages:

- `feat: add X`
- `fix: resolve Y`
- `docs: update Z`
- `chore: maintain tooling`

## Pull Request Checklist

- [ ] Code builds locally
- [ ] Related docs updated
- [ ] No secrets added
- [ ] Scope matches PR description

## Reporting Issues

When opening an issue, include:

- Expected behavior
- Actual behavior
- Repro steps
- OS / Node / app version
- Relevant logs or screenshots
