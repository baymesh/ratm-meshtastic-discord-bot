FROM node:20

WORKDIR /app

COPY package*.json ./

RUN npm install

COPY . .

RUN git clone https://github.com/meshtastic/protobufs.git src/protobufs

CMD [ "node", "src/index.js" ]