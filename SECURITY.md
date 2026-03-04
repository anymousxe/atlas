# Security Policy

## Supported Versions

Security updates are provided for the latest release line.

## Reporting a Vulnerability

Please do **not** open public issues for security vulnerabilities.

Report privately with:

- A clear description of the issue
- Impact assessment
- Reproduction steps
- Suggested mitigation (if known)

Until a dedicated security contact is published, use repository owner channels for responsible disclosure.

## Security Practices

- Keep API keys in environment variables only
- Use Cloudflare Worker secrets for production
- Never commit `.env` files
- Rotate keys if exposure is suspected

See also `SECURITY_BEST_PRACTICES.md`.
