// Application logger.
//
// One pino instance, created here, imported everywhere. Two properties matter:
//
//   1. Redaction. Anything that smells like a credential is replaced before it
//      reaches a log sink. This is belt-and-braces: call sites are written not
//      to log secrets in the first place, but `req.headers` gets logged by
//      pino-http and we do not want a stray Authorization header in a file.
//   2. Test friendliness. Under NODE_ENV=test we emit JSON to stdout at `silent`
//      level so a failing test's output stays readable.
import pino from 'pino';
import { config } from './config.js';

const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.headers["x-hub-signature"]',
  'req.headers["x-hub-signature-256"]',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.githubToken',
  '*.apiKey',
  '*.secret',
  '*.jwt',
  '*.authorization',
];

export const logger = pino({
  level: config.isTest ? 'silent' : config.logLevel,
  redact: {
    paths: REDACTED_PATHS,
    censor: '[redacted]',
  },
  // Never let a stray object dump a whole repository file into the log.
  serializers: {
    err: pino.stdSerializers.err,
  },
  base: { service: 'ci-investigator-backend' },
});

export default logger;