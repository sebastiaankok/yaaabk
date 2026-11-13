import { app } from './app';

const port = Number(process.env['PORT'] ?? {{port}});

export default {
  port,
  fetch: app.fetch,
};

console.log(`{{projectName}} listening on http://localhost:${port}`);
