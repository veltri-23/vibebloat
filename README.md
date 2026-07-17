# VibeBloat

Local tripwires for mistakes AI coding agents repeat.

## Status

Hackathon build in progress. Do not treat this package as a published release yet.

## Development

```sh
bun test
bun src/cli.ts doctor
```

## Architecture

- Guards are declarative data.
- Trusted runtime actions perform every effect.
- History is scrubbed before any model pass.
- Native agent hooks and fallback chokepoints share one matcher.

## License

Apache-2.0. See `LICENSE`.
