import { createApp } from './app.ts';
const port = Number(process.env.PORT ?? 8099);
createApp().listen(port, '127.0.0.1', () => console.log('dev server on', port));
