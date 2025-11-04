# Use a imagem base do Node.js recomendada pela Render
FROM node:18-bullseye-slim

# Instala as dependências do sistema necessárias para o Puppeteer (Chromium)
# Esta é a parte mais importante
RUN apt-get update && apt-get install -yq \
    gconf-service libasound2 libatk1.0-0 libc6 libcairo2 libcups2 libdbus-1-3 \
    libexpat1 libfontconfig1 libgcc1 libgconf-2-4 libgdk-pixbuf2.0-0 libglib2.0-0 \
    libgtk-3-0 libnspr4 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 \
    libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates fonts-liberation \
    libappindicator1 libnss3 lsb-release xdg-utils wget

# Define o diretório de trabalho dentro do contêiner
WORKDIR /usr/src/app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências do Node.js
RUN npm install

# Copia o resto do código da sua aplicação
COPY . .

# Expõe a porta que sua aplicação usa
EXPOSE 10000

# Comando para iniciar a aplicação
CMD ["node", "server.js"]
