FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install
RUN npm install -g tsx

COPY . .

RUN git clone https://github.com/meshtastic/protobufs.git src/protobufs

CMD [ "tsx", "index.ts" ]