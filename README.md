# clipboard-sync

Clipboard synchronization server and client

## How to use

1. 使用普通TCP

   - 启动服务器：

   ```bash
   node index.js server -p 8080
   ```

   - 启动客户端：

   ```bash
   node index.js client -p 8080 -h <server_host>
   ```

2. 使用TLS加密

   - 生成自签名TLS证书

   ```bash
   openssl req -newkey rsa:2048 -nodes -keyout server.key -x509 -days 365 -out server.crt
   ```

   - 启动服务器：

   ```bash
   node index.js server -p 8080 -secure -key ./server.key -cert ./server.crt
   ```

   - 启动客户端：

   ```bash
   node index.js client -p 8080 -h <server_host> -secure
   ```
