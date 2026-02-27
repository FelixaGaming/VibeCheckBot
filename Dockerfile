FROM node:20-alpine

WORKDIR /app

COPY package.json ./

RUN npm install && \
    npm install @sapphire/shapeshift@3.9.7 --save-exact && \
    npm install discord.js@14.14.1 --save-exact

COPY . .

CMD ["node", "bot.js"]
