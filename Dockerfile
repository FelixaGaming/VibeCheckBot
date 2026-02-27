FROM node:20-alpine
WORKDIR /app
RUN npm install discord.js@14.11.0 openai@4.28.0 resend@2.1.0 @supabase/supabase-js@2.39.0 dotenv@16.4.1
COPY . .
CMD ["node", "bot.js"]
