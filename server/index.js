import express    from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { setupWSS } from './wss.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const app    = express();
const server = createServer(app);

// Serve static client files
app.use(express.static(join(__dir, '../client')));

app.use((req, res) => {
  res.sendFile(join(__dir, '../client/index.html'));
});

setupWSS(server);

const PORT = process.env.PORT || 6967;
server.listen(PORT, () =>
  console.log(
    `SecureChat running on http://localhost:${PORT}`));