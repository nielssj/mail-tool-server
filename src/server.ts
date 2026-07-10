import { buildApp } from './app.js';

const host = process.env.HOST ?? '0.0.0.0';
const port = Number(process.env.PORT ?? 3000);

const app = buildApp();

const start = async (): Promise<void> => {
  try {
    await app.listen({ host, port });
  } catch (error) {
    app.log.error(error, 'Failed to start server');
    process.exit(1);
  }
};

void start();
