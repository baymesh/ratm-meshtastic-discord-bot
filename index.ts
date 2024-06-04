import crypto from "crypto";
import path from "path";
import mqtt from "mqtt";
import postgres from "postgres";
import protobufjs from "protobufjs";
import fs from "fs";
import axios from "axios";
import { fileURLToPath } from "url";
import { dirname } from "path";
import FifoKeyCache from "./src/FifoKeyCache";
import MeshPacketQueue, { PacketGroup } from "./src/MeshPacketQueue";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";
import { createClient } from "redis";

// generate a pseduo uuid kinda thing to use as an instance id
const INSTANCE_ID = (() => {
  return crypto.randomBytes(4).toString("hex");
})();

const logger = {
  info: (message: string) => {
    console.log(
      `${new Date().toISOString()} [${INSTANCE_ID}] [INFO] ${message}`,
    );
  },
  error: (message: string) => {
    console.log(
      `${new Date().toISOString()} [${INSTANCE_ID}] [ERROR] ${message}`,
    );
  },
  debug: (message: string) => {
    console.log(
      `${new Date().toISOString()} [${INSTANCE_ID}] [DEBUG] ${message}`,
    );
  },
};

Sentry.init({
  environment: process.env.ENVIRONMENT || "development",
  integrations: [nodeProfilingIntegration()],
  // Performance Monitoring
  tracesSampleRate: 1.0, //  Capture 100% of the transactions

  // Set sampling rate for profiling - this is relative to tracesSampleRate
  profilesSampleRate: 1.0,
});

Sentry.setTag("instance_id", INSTANCE_ID);

logger.info(`Starting Rage Against Mesh(ine) ${INSTANCE_ID}`);

const mqttBrokerUrl = "mqtt://mqtt.meshtastic.org";
const mqttUsername = "meshdev";
const mqttPassword = "large4cats";

const sql = postgres(process.env.DATABASE_URL, {});

const redisClient = createClient({
  url: process.env.REDIS_URL,
});

(async () => {
  if (process.env.REDIS_ENABLED === "true") {
    // Connect to redis server
    await redisClient.connect();
    logger.info(`Setting active instance id to ${INSTANCE_ID}`);
    redisClient.set(`baymesh:active`, INSTANCE_ID);
  }
})();

const decryptionKeys = [
  "1PG7OiApB1nwvP+rz05pAQ==", // add default "AQ==" decryption key
];

const nodeDB = JSON.parse(fs.readFileSync("./nodeDB.json").toString());
const ignoreDB = JSON.parse(fs.readFileSync("./ignoreDB.json").toString());
const cache = new FifoKeyCache();
const meshPacketQueue = new MeshPacketQueue();

const updateNodeDB = (node: string, longName: string) => {
  nodeDB[node] = longName;
  if (process.env.REDIS_ENABLED === "true") {
    redisClient.set(`baymesh:node:${node}`, longName);
  }
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
const Position = root.lookupType("Position");

if (!process.env.DISCORD_WEBHOOK_URL) {
  logger.error("DISCORD_WEBHOOK_URL not set");
  process.exit(-1);
}

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
const mesh_topic = process.env.MQTT_TOPIC || "msh/US/bayarea";
const grouping_duration = parseInt(process.env.GROUPING_DURATION || "10000");

function sendDiscordMessage(payload: any) {
  const data = typeof payload === "string" ? { content: payload } : payload;

  return axios
    .post(webhookUrl, data)
    .then(() => {
      // console.log("Message sent successfully");
    })
    .catch((error) => {
      logger.error(
        `[error] Could not send discord message: ${error.response.status}`,
      );
    });
}

Object.keys(nodeDB).forEach((nodeId) => {
  if (process.env.REDIS_ENABLED === "true") {
    const longName = nodeDB[nodeId];
    redisClient.exists(`baymesh:node:${nodeId}`).then((exists) => {
      if (!exists) {
        redisClient.set(`baymesh:node:${nodeId}`, longName);
      }
    });
  }
});

function processTextMessage(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const text = packet.decoded.payload.toString();
  createDiscordMessage(packetGroup, text);
}

function createDiscordMessage(packetGroup, text) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const to = packet.to.toString(16);
  const from = packet.from.toString(16);

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
            name: `Message (${packetGroup.id.toString(16)})`,
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

              if (
                envelope.gatewayId === "!75f1804c" ||
                envelope.gatewayId === "!3b46b95c"
              ) {
                // console.log(envelope);
              }

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
    logger.info(
      `MessageId: ${packetGroup.id} Ignoring message from ${prettyNodeName(
        from,
      )} to ${prettyNodeName(to)} : ${text}`,
    );
  } else {
    logger.info(
      `MessageId: ${packetGroup.id} Received message from ${prettyNodeName(from)} to ${prettyNodeName(to)} : ${text}`,
    );
    // ignore packets older than 5 minutes
    if (new Date(packet.rxTime * 1000) < new Date(Date.now() - 5 * 60 * 1000)) {
      logger.info(
        `MessageId: ${packetGroup.id} Ignoring old message from ${prettyNodeName(
          from,
        )} to ${prettyNodeName(to)} : ${text}`,
      );
    } else {
      if (to == "ffffffff") {
        if (
          packetGroup.serviceEnvelopes.filter(
            (envelope) => envelope.topic.indexOf("msh/US/bayarea/") !== -1,
          ).length > 0
        ) {
          sendDiscordMessage(content);
        } else {
          logger.info(
            `MessageId: ${packetGroup.id} No packets found in topic: ${packetGroup.serviceEnvelopes.map((envelope) => envelope.topic)}`,
          );
        }
      }
    }
  }
}

async function insertMeshPositionReport(packetGroup: PacketGroup) {
  const packet = packetGroup.serviceEnvelopes[0].packet;
  const from = packet.from;
  const position = Position.decode(
    packetGroup.serviceEnvelopes[0].packet.decoded.payload,
  );

  const latitude = position.latitudeI / 10000000;
  const longitude = position.longitudeI / 10000000;
  const altitude = position.altitude;

  const topics = Array.from(
    new Set(
      packetGroup.serviceEnvelopes.map((envelope) =>
        envelope.topic.slice(0, envelope.topic.indexOf("/!")),
      ),
    ),
  );

  const gateways = packetGroup.serviceEnvelopes.map((envelope) =>
    envelope.gatewayId.replace("!", ""),
  );

  try {
    return await sql`
      INSERT INTO mesh_position_reports
      ("from", "from_hex", latitude, longitude, altitude, topics, gateways)
      values
        (${from}, ${nodeId2hex(from)}, ${latitude}, ${longitude}, ${altitude}, ${topics}, ${gateways})
    `;
  } catch (error) {
    logger.error(
      `MessageId: ${packetGroup.id} Error inserting mesh position report: ${error}`,
    );
  }
  return null;
}

const client = mqtt.connect(mqttBrokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
});

const topics = [
  "msh/US/bayarea",
  "msh/US/BayArea",
  "msh/US/CA/bayarea",
  "msh/US/CA/BayArea",
  "msh/US/sacvalley",
  "msh/US/SacValley",
  "msh/US/CA/sacvalley",
  "msh/US/CA/SacValley",
  "msh/US/CA/CenValMesh",
  "msh/US/CA/cenvalmesh",
  "msh/US/CA/centralvalley",
  "msh/US/CA/CentralValley",
  "msh/US/CenValMesh",
  "msh/US/cenvalmesh",
  "msh/US/centralvalley",
  "msh/US/CentralValley",
];

// run every 5 seconds and pop off from the queue
const processing_timer = setInterval(() => {
  if (process.env.REDIS_ENABLED === "true") {
    redisClient.get(`baymesh:active`).then((active_instance) => {
      if (active_instance && active_instance !== INSTANCE_ID) {
        logger.error(
          `Stopping RATM instance; active_instance: ${active_instance} this instance: ${INSTANCE_ID}`,
        );
        clearInterval(processing_timer); // do we want to kill it so fast? what about things in the queue?
        topics.forEach((topic) => client.unsubscribe(topic));
      }
    });
  }
  const packetGroups = meshPacketQueue.popPacketGroupsOlderThan(
    Date.now() - grouping_duration,
  );
  packetGroups.forEach((packetGroup) => {
    processPacketGroup(packetGroup);
  });
}, 5000);

function sub(topic: string) {
  client.subscribe(`${topic}/#`, (err) => {
    if (!err) {
      logger.info(`Subscribed to ${topic}/#`);
    } else {
      logger.error(`Subscription error: ${err.message}`);
    }
  });
}

/*
sub("msh/US/bayarea");
sub("msh/US/BayArea");
sub("msh/US/CA/bayarea");
sub("msh/US/CA/BayArea");
sub("msh/US/sacvalley");
sub("msh/US/SacValley");
sub("msh/US/CA/sacvalley");
sub("msh/US/CA/SacValley");
sub("msh/US/CA/CenValMesh");
sub("msh/US/CA/cenvalmesh");
sub("msh/US/CA/centralvalley");
sub("msh/US/CA/CentralValley");
sub("msh/US/CenValMesh");
sub("msh/US/cenvalmesh");
sub("msh/US/centralvalley");
sub("msh/US/CentralValley");
*/

// subscribe to everything when connected
client.on("connect", () => {
  logger.info(`Connected to MQTT broker`);
  topics.forEach((topic) => sub(topic));
});

// handle message received
client.on("message", async (topic: string, message: any) => {
  try {
    if (topic.includes("msh")) {
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
          logger.debug(
            `FifoCache: Already received envelope with hash ${shaHash(envelope)} MessageId: ${envelope.packet.id}  Gateway: ${envelope.gatewayId}`,
          );
          return;
        }

        if (cache.add(shaHash(envelope))) {
          // periodically print the nodeDB to the console
          //console.log(JSON.stringify(nodeDB));
        }

        meshPacketQueue.add(envelope, topic);
      }
    }
  } catch (err) {
    logger.error(String(err));
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
  } else if (portnum === 3) {
    if (process.env.DB_INSERTS_ENABLED === "true") {
      insertMeshPositionReport(packetGroup);
    }
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
