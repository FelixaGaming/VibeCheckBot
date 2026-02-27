FROM node:20-alpine

WORKDIR /app

COPY package.json ./

RUN npm install --no-package-lock discord.js@14.16.3 openai@4 resend@2 @supabase/supabase-js@2 dotenv@16

COPY . .

CMD ["node", "bot.js"]
