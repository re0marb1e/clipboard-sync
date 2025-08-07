const net = require('net');
const tls = require('tls');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

// Promisify exec for async clipboard access
const execPromise = util.promisify(exec);

// Parse command line arguments
const args = process.argv.slice(2);
let port = 3000;
let host = 'localhost';
let mode = 'server';
let secure = false;
let keyPath = null;
let certPath = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-p' && i + 1 < args.length) {
    port = parseInt(args[i + 1]);
    i++;
  } else if (args[i] === '-h' && i + 1 < args.length) {
    host = args[i + 1];
    i++;
  } else if (args[i] === '-secure') {
    secure = true;
  } else if (args[i] === '-key' && i + 1 < args.length) {
    keyPath = args[i + 1];
    i++;
  } else if (args[i] === '-cert' && i + 1 < args.length) {
    certPath = args[i + 1];
    i++;
  } else if (args[i] === 'server' || args[i] === 'client') {
    mode = args[i];
  }
}

if (isNaN(port) || port < 1 || port > 65535) {
  console.error('Invalid port number, using default port 3000');
  port = 3000;
}

// Validate TLS parameters for secure mode
if (secure && mode === 'server' && (!keyPath || !certPath)) {
  console.error('Error: -secure requires -key <path> and -cert <path> for server mode');
  process.exit(1);
}

// Determine clipboard command based on platform (global)
const isWindows = process.platform === 'win32';
const clipboardReadCommand = isWindows ? 'powershell -command Get-Clipboard' : 'pbpaste';
const clipboardWriteCommand = isWindows ? 'clip' : 'pbcopy';

// Server implementation
function startServer(port) {
  // TLS options for server
  let serverOptions = {};
  if (secure) {
    try {
      serverOptions = {
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      };
    } catch (err) {
      console.error(`Error reading TLS files: ${err.message}`);
      process.exit(1);
    }
  }

  // Create server based on secure flag
  const server = secure ? tls.createServer(serverOptions, handleConnection) : net.createServer(handleConnection);

  function handleConnection(socket) {
    let buffer = '';

    let lastClientContent = ''; // Track last content received from client
    let lastClipboardContent = ''; // Track last clipboard content sent
    let skipNextCheck = false; // Flag to skip check after receiving data

    socket.on('data', (data) => {
      buffer += data.toString('utf8');

      while (buffer.length > 0) {
        // Check for header delimiter (\r\n\r\n or \n\n)
        let headerEnd = buffer.indexOf('\r\n\r\n');
        let delimiterLength = 4;
        if (headerEnd === -1) {
          headerEnd = buffer.indexOf('\n\n');
          delimiterLength = 2;
        }
        if (headerEnd === -1) {
          console.log('No delimiter found in buffer:', buffer);
          return;
        }

        // Extract header and content (UTF-8)
        const header = buffer.slice(0, headerEnd);
        const content = buffer.slice(headerEnd + delimiterLength);

        // Parse Content-Length
        const match = header.match(/Content-Length: (\d+)/i);
        if (!match) {
          console.error('Invalid Content-Length header:', header);
          buffer = '';
          return;
        }

        const contentLength = parseInt(match[1]);

        // Wait until we have all content (check byte length in UTF-8)
        if (Buffer.byteLength(content, 'utf8') < contentLength) return;

        // Process complete request
        const body = content.slice(0, contentLength);
        console.log('Received body:');
        console.log(body);

        // Copy body to clipboard
        execPromise(`printf %s "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | ${clipboardWriteCommand}`)
          .then(() => {
            console.log('Body copied to clipboard');
            lastClientContent = body; // Update last client content
            skipNextCheck = true; // Skip next clipboard check to avoid loop
          })
          .catch((err) => console.error('Error copying to clipboard:', err));
        // Update buffer for next message
        buffer = content.slice(contentLength);
      }
    });

    // Periodically check clipboard and send data if changed and not from client
    async function checkAndSendClipboardData() {
      if (skipNextCheck) {
        skipNextCheck = false;
        return; // Skip this check to prevent echoing received data
      }
      try {
        const { stdout } = await execPromise(clipboardReadCommand);
        const data = stdout.trim();
        if (data && data !== lastClipboardContent && data !== lastClientContent) {
          // Construct message with UTF-8 encoding
          const contentLength = Buffer.byteLength(data, 'utf8');
          const message = `Content-Length: ${contentLength}\r\n\r\n${data}`;
          console.log('Sending to client:', message);
          socket.write(Buffer.from(message, 'utf8')); // Ensure UTF-8 encoding
          lastClipboardContent = data; // Update last sent content
        }
      } catch (err) {
        console.error('Error reading clipboard:', err);
      }
    }

    // Check clipboard every 2 seconds
    setInterval(checkAndSendClipboardData, 2000);

    socket.on('error', (err) => {
      console.error('Socket error:', err);
    });

    socket.on('end', () => {
      console.log('Client disconnected');
    });
  }

  server.on('error', (err) => {
    console.error('Server error:', err);
  });

  server.listen(port, () => {
    console.log(`Server running on port ${port}${secure ? ' with TLS' : ''}`);
  });
}

// Client implementation
async function startClient(port, host) {
  // TLS options for client (accept self-signed certificate for testing)
  const clientOptions = secure ? {
    host,
    port,
    rejectUnauthorized: false // Allow self-signed certificate
  } : { host, port };

  // Create client connection based on secure flag
  const client = secure ? tls.connect(clientOptions, onConnect) : net.createConnection(clientOptions, onConnect);

  function onConnect() {
    console.log(`Connected to server at ${host}:${port}${secure ? ' with TLS' : ''}`);
  }

  let lastClipboardContent = ''; // Track last content sent to server
  let lastReceivedContent = ''; // Track last content received from server
  let skipNextCheck = false; // Flag to skip check after receiving data

  // Handle incoming data from server
  let buffer = '';
  client.on('data', (data) => {
    buffer += data.toString('utf8');

    while (buffer.length > 0) {
      // Check for header delimiter (\r\n\r\n or \n\n)
      let headerEnd = buffer.indexOf('\r\n\r\n');
      let delimiterLength = 4;
      if (headerEnd === -1) {
        headerEnd = buffer.indexOf('\n\n');
        delimiterLength = 2;
      }
      if (headerEnd === -1) {
        console.log('No delimiter found in buffer:', buffer);
        return;
      }

      // Extract header and content (UTF-8)
      const header = buffer.slice(0, headerEnd);
      const content = buffer.slice(headerEnd + delimiterLength);

      // Parse Content-Length
      const match = header.match(/Content-Length: (\d+)/i);
      if (!match) {
        console.error('Invalid Content-Length header:', header);
        buffer = '';
        return;
      }

      const contentLength = parseInt(match[1]);

      // Wait until we have all content (check byte length in UTF-8)
      if (Buffer.byteLength(content, 'utf8') < contentLength) return;

      // Process complete request
      const body = content.slice(0, contentLength);
      console.log('Received body from server:');
      console.log(body);

      // Copy body to clipboard
      execPromise(`printf %s "${body.replace(/"/g, '\\"').replace(/\n/g, '\\n')}" | ${clipboardWriteCommand}`)
        .then(() => {
          console.log('Body copied to clipboard');
          lastReceivedContent = body; // Update last received content
          skipNextCheck = true; // Skip next clipboard check to avoid loop
        })
        .catch((err) => console.error('Error copying to clipboard:', err));
      // Update buffer for next message
      buffer = content.slice(contentLength);
    }
  });

  // Periodically check clipboard and send data if changed and not from server
  async function checkAndSendClipboardData() {
    if (skipNextCheck) {
      skipNextCheck = false;
      return; // Skip this check to prevent echoing received data
    }
    try {
      const { stdout } = await execPromise(clipboardReadCommand);
      const data = stdout.trim();
      if (data && data !== lastClipboardContent && data !== lastReceivedContent) {
        // Construct message with UTF-8 encoding
        const contentLength = Buffer.byteLength(data, 'utf8');
        const message = `Content-Length: ${contentLength}\r\n\r\n${data}`;
        console.log('Sending:', message);
        client.write(Buffer.from(message, 'utf8')); // Ensure UTF-8 encoding
        lastClipboardContent = data; // Update last sent content
      }
    } catch (err) {
      console.error('Error reading clipboard:', err);
    }
  }

  // Check clipboard every 2 seconds
  setInterval(checkAndSendClipboardData, 2000);

  client.on('error', (err) => {
    console.error('Client error:', err);
  });

  client.on('end', () => {
    console.log('Disconnected from server');
  });
}

// Start server or client based on mode
if (mode === 'server') {
  startServer(port);
} else if (mode === 'client') {
  startClient(port, host);
} else {
  console.error('Invalid mode. Use "server" or "client".');
}