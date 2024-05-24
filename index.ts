import crypto from "crypto";
import path from "path";
import mqtt from "mqtt";
import protobufjs from "protobufjs";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import FifoKeyCache from "./src/FifoKeyCache";
import MeshPacketQueue, { PacketGroup } from "./src/MeshPacketQueue";

const mqttBrokerUrl = "mqtt://mqtt.meshtastic.org";
const mqttUsername = "meshdev";
const mqttPassword = "large4cats";

const decryptionKeys = [
  "1PG7OiApB1nwvP+rz05pAQ==", // add default "AQ==" decryption key
];

const nodeDB = JSON.parse(fs.readFileSync("./nodeDB.json").toString());
const ignoreDB = JSON.parse(fs.readFileSync("./ignoreDB.json").toString());
const cache = new FifoKeyCache();
const meshPacketQueue = new MeshPacketQueue();

const updateNodeDB = (node: string, longName: string) => {
  nodeDB[node] = longName;
  fs.writeFileSync(
    path.join(__dirname, "./nodeDB.json"),
    JSON.stringify(nodeDB, null, 2),
  );
};

const isInIgnoreDB = (node: string) => {
  return ignoreDB.includes(node);
};

const getNodeName = (nodeId: string | number) => {
  return nodeDB[nodeId2hex(nodeId)] || "Unknown";
};

const nodeId2hex = (nodeId: string | number) => {
  return typeof nodeId === "number" ? nodeId.toString(16) : nodeId;
};

const prettyNodeName = (nodeId: string | number) => {
  const nodeIdHex = nodeId2hex(nodeId);
  const nodeName = getNodeName(nodeId);
  return nodeName ? `${nodeIdHex} - ${nodeName}` : nodeIdHex;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// load protobufs
const root = new protobufjs.Root();
root.resolvePath = (origin, target) =>
  path.join(__dirname, "src/protobufs", target);
root.loadSync("meshtastic/mqtt.proto");
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");
const User = root.lookupType("User");

if (!process.env.DISCORD_WEBHOOK_URL) {
  console.error("DISCORD_WEBHOOK_URL not set");
  process.exit(-1);
}

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

function sendDiscordMessage(payload: any) {
  const data = typeof payload === "string" ? { content: payload } : payload;

  return axios
    .post(webhookUrl, data)
    .then(() => {
      // console.log("Message sent successfully");
    })
    .catch((error) => {
      console.error(
        `${new Date().toUTCString()} [error] Could not send discord message: ${error.response.status}`,
      );
    });
}

function processTextMessage(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const to = packet.to.toString(16);
  const from = packet.from.toString(16);
  const text = packet.decoded.payload.toString();

  // discard text messages in the form of "seq 6034" "seq 6025"
  if (text.match(/^seq \d+$/)) {
    return;
  }

  const nodeIdHex = nodeId2hex(from);
  const nodeName = getNodeName(from);

  const nodeUrl = `https://meshtastic.liamcottle.net/?node_id=${packet.from}`;

  const content = {
    username: "Bayme.sh Bot",
    avatar_url:
      "https://cdn.discordapp.com/app-icons/1240017058046152845/295e77bec5f9a44f7311cf8723e9c332.png",
    embeds: [
      {
        url: nodeUrl,
        color: 6810260,
        timestamp: new Date(packet.rxTime * 1000).toISOString(),

        author: {
          name: `${nodeName}`,
          url: nodeUrl,
          icon_url: "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        fields: [
          {
            name: "Message",
            value: text,
          },
          {
            name: "Node ID",
            value: `${nodeIdHex}`,
            // inline: true,
          },
          ...packetGroup.serviceEnvelopes
            .filter(
              (value, index, self) =>
                self.findIndex((t) => t.gatewayId === value.gatewayId) ===
                index,
            )
            .map((envelope) => {
              const gatewayDelay =
                envelope.mqttTime.getTime() - packetGroup.time.getTime();
              return {
                name: "Gateway",
                value: `${prettyNodeName(envelope.gatewayId.replace("!", ""))} (${envelope.packet.hopStart - envelope.packet.hopLimit}/${envelope.packet.hopStart} hops)${gatewayDelay > 0 ? " (" + gatewayDelay + "ms)" : ""}`,
                inline: true,
              };
            }),
        ],
      },
    ],
  };

  //console.log(packetGroup, packetGroup.serviceEnvelopes);

  if (isInIgnoreDB(from)) {
    console.log(
      `${new Date().toUTCString()} [info] Ignoring message from ${prettyNodeName(
        from,
      )} to ${prettyNodeName(to)} : ${text}`,
    );
  } else {
    console.log(
      `${new Date().toUTCString()} [info] Received message from ${prettyNodeName(from)} to ${prettyNodeName(to)} : ${text}`,
    );
    if (to === "ffffffff") {
      sendDiscordMessage(content);
    }
  }
}

const client = mqtt.connect(mqttBrokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
});

// run every 5 seconds and pop off from the queue
setInterval(() => {
  const packetGroups = meshPacketQueue.popPacketGroupsOlderThan(
    Date.now() - 10000,
  );
  packetGroups.forEach((packetGroup) => {
    processPacketGroup(packetGroup);
  });
}, 5000);

const mesh_topic = "msh/US/bayarea";

// subscribe to everything when connected
client.on("connect", () => {
  console.log(`${new Date().toUTCString()} [info] connected to mqtt broker`);
  client.subscribe(`${mesh_topic}/#`, (err) => {
    if (!err) {
      console.log(
        `${new Date().toUTCString()} [info] subscribed to ${mesh_topic}/#`,
      );
    } else {
      console.error(
        `${new Date().toUTCString()} [error] subscription error: ${err.message}`,
      );
    }
  });
});

// handle message received
client.on("message", async (topic: string, message: any) => {
  try {
    if (topic.includes(mesh_topic)) {
      if (!topic.includes("/json")) {
        if (topic.includes("/stat/")) {
          return;
        }
        // decode service envelope
        const envelope = ServiceEnvelope.decode(message);
        if (!envelope.packet) {
          return;
        }

        // attempt to decrypt encrypted packets
        const isEncrypted = envelope.packet.encrypted?.length > 0;
        if (isEncrypted) {
          const decoded = decrypt(envelope.packet);
          if (decoded) {
            envelope.packet.decoded = decoded;
          }
        }

        if (cache.exists(shaHash(envelope))) {
          console.log(
            "FifoCache: Already received envelope with hash",
            shaHash(envelope),
            " Gateway: ",
            envelope.gatewayId,
          );
          return;
        }

        if (cache.add(shaHash(envelope))) {
          // periodically print the nodeDB to the console
          console.log(JSON.stringify(nodeDB));
        }

        meshPacketQueue.add(envelope);
      }
    }
  } catch (err) {
    console.log(err);
  }
});

function shaHash(serviceEnvelope: ServiceEnvelope) {
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify(serviceEnvelope));
  return hash.digest("hex");
}

function processPacketGroup(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const portnum = packet?.decoded?.portnum;

  if (portnum === 1) {
    processTextMessage(packetGroup);
  } else if (portnum === 4) {
    const user = User.decode(packet.decoded.payload);
    const from = packet.from.toString(16);
    updateNodeDB(from, user.longName);
  }
}

function createNonce(packetId, fromNode) {
  // Expand packetId to 64 bits
  const packetId64 = BigInt(packetId);

  // Initialize block counter (32-bit, starts at zero)
  const blockCounter = 0;

  // Create a buffer for the nonce
  const buf = Buffer.alloc(16);

  // Write packetId, fromNode, and block counter to the buffer
  buf.writeBigUInt64LE(packetId64, 0);
  buf.writeUInt32LE(fromNode, 8);
  buf.writeUInt32LE(blockCounter, 12);

  return buf;
}

/**
 * References:
 * https://github.com/crypto-smoke/meshtastic-go/blob/develop/radio/aes.go#L42
 * https://github.com/pdxlocations/Meshtastic-MQTT-Connect/blob/main/meshtastic-mqtt-connect.py#L381
 */
function decrypt(packet) {
  // attempt to decrypt with all available decryption keys
  for (const decryptionKey of decryptionKeys) {
    try {
      // console.log(`using decryption key: ${decryptionKey}`);
      // convert encryption key to buffer
      const key = Buffer.from(decryptionKey, "base64");

      // create decryption iv/nonce for this packet
      const nonceBuffer = createNonce(packet.id, packet.from);

      // create aes-128-ctr decipher
      const decipher = crypto.createDecipheriv("aes-128-ctr", key, nonceBuffer);

      // decrypt encrypted packet
      const decryptedBuffer = Buffer.concat([
        decipher.update(packet.encrypted),
        decipher.final(),
      ]);

      // parse as data message
      return Data.decode(decryptedBuffer);
    } catch (e) {
      // console.log(e);
    }
  }

  // couldn't decrypt
  return null;
}
