const crypto = require("crypto");
const path = require("path");
const mqtt = require("mqtt");
const protobufjs = require("protobufjs");
const fs = require("fs");
const axios = require("axios");
const FifoKeyCache = require("./FifoKeyCache");

const mqttBrokerUrl = "mqtt://mqtt.meshtastic.org";
const mqttUsername = "meshdev";
const mqttPassword = "large4cats";

const decryptionKeys = [
  "1PG7OiApB1nwvP+rz05pAQ==", // add default "AQ==" decryption key
];

const nodeDB = require("../nodeDB.json");
const cache = new FifoKeyCache();

const updateNodeDB = (node, longName) => {
  nodeDB[node] = longName;
  fs.writeFileSync(
    path.join(__dirname, "../nodeDB.json"),
    JSON.stringify(nodeDB, null, 2),
  );
};

const getNodeName = (nodeId) => {
  return nodeDB[nodeId2hex(nodeId)] || "Unknown";
};

const nodeId2hex = (nodeId) => {
  return typeof nodeId === "number" ? nodeId.toString(16) : nodeId;
};

const prettyNodeName = (nodeId) => {
  const nodeIdHex = nodeId2hex(nodeId);
  const nodeName = getNodeName(nodeId);
  return nodeName ? `${nodeIdHex} (${nodeName})` : nodeIdHex;
};

const prettyNeighbourInfo = (neighbourInfo) => {
  return {
    neighbors: neighbourInfo.neighbors.map((n) => {
      return {
        node: prettyNodeName(n.nodeId),
        snr: n.snr,
      };
    }),
    nodeId: prettyNodeName(neighbourInfo.nodeId),
    lastSentById: prettyNodeName(neighbourInfo.lastSentById),
    nodeBroadcastIntervalSecs: neighbourInfo.nodeBroadcastIntervalSecs,
  };
};

const prettyRouteDiscovery = (routeDiscovery) => {
  return {
    from: getNodeName(routeDiscovery.from),
    route: routeDiscovery.route.map((nodeId) => {
      return prettyNodeName(nodeId);
    }),
  };
};

// load protobufs
const root = new protobufjs.Root();
root.resolvePath = (origin, target) =>
  path.join(__dirname, "protobufs", target);
root.loadSync("meshtastic/mqtt.proto");
const Data = root.lookupType("Data");
const ServiceEnvelope = root.lookupType("ServiceEnvelope");
const NeighborInfo = root.lookupType("NeighborInfo");
const Position = root.lookupType("Position");
const Routing = root.lookupType("Routing");
const RouteDiscovery = root.lookupType("RouteDiscovery");
const Telemetry = root.lookupType("Telemetry");
const User = root.lookupType("User");

const webhookUrl = process.env.DISCORD_WEBHOOK_URL;

function sendDiscordMessage(payload) {
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

const client = mqtt.connect(mqttBrokerUrl, {
  username: mqttUsername,
  password: mqttPassword,
});

// subscribe to everything when connected
client.on("connect", () => {
  console.log(`${new Date().toUTCString()} [info] connected to mqtt broker`);
  client.subscribe("#");
});

// handle message received
client.on("message", async (topic, message) => {
  try {
    if (topic.includes("msh/US/bayarea")) {
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

        const portnum = envelope.packet?.decoded?.portnum;
        const id = envelope.packet?.id;
        const rssi = envelope.packet?.rxRssi;

        if (id !== 0 && portnum !== undefined && cache.exists(id)) {
          // console.log(
          //   "FifoCache: Already received packet with id",
          //   id,
          //   " Gateway: ",
          //   envelope.gatewayId,
          //   " rssi: ",
          //   rssi,
          // );
          // cache.debuger();
          return;
        }

        if (id !== 0 && portnum !== undefined) {
          if (cache.add(envelope.packet?.id)) {
            // periodically print the nodeDB to the console
            console.log(JSON.stringify(nodeDB));
          }
        }

        if (portnum === 1) {
          const to = envelope.packet.to.toString(16);
          const from = envelope.packet.from.toString(16);
          const text = envelope.packet.decoded.payload.toString();

          // discard text messages in the form of "seq 6034" "seq 6025"
          if (text.match(/^seq \d+$/)) {
            console.log(
              `received packet ${id} from ${prettyNodeName(envelope.packet.from)} with rssi ${rssi} on port ${portnum}`,
            );
            console.log(envelope);
            console.log(envelope.packet);
            return;
          }

          const nodeIdHex = nodeId2hex(from);
          const nodeName = getNodeName(from);

          const nodeUrl = `https://meshtastic.liamcottle.net/?node_id=${envelope.packet.from}`;

          const content = {
            username: "Bayme.sh Bot",
            avatar_url:
              "https://cdn.discordapp.com/app-icons/1240017058046152845/295e77bec5f9a44f7311cf8723e9c332.png",
            embeds: [
              {
                url: nodeUrl,
                color: 6810260,
                timestamp: new Date(
                  envelope.packet.rxTime * 1000,
                ).toISOString(),

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
                    inline: true,
                  },
                  {
                    name: "Gateway",
                    value: prettyNodeName(envelope.gatewayId.replace("!", "")),
                    inline: true,
                  },
                ],
              },
            ],
          };

          if (to === "ffffffff") {
            console.log(
              `${new Date().toUTCString()} [info] Received message for me from ${getNodeName(from)}: ${text}`,
            );
            sendDiscordMessage(content);
          }

          // console.log("TEXT_MESSAGE_APP", {
          //   to: prettyNodeName(to),
          //   from: prettyNodeName(from),
          //   text,
          //   id,
          // });
        } else if (portnum === 3) {
          const position = Position.decode(envelope.packet.decoded.payload);
          const from = envelope.packet.from.toString(16);

          // console.log("POSITION_APP", {
          //   from: prettyNodeName(from),
          //   position: position,
          //   id,
          // });
        } else if (portnum === 4) {
          const user = User.decode(envelope.packet.decoded.payload);
          const from = envelope.packet.from.toString(16);

          if (updateNodeDB(from, user.longName)) {
            console.log(nodeDB);
          }

          // console.log("NODEINFO_APP", {
          //   from: prettyNodeName(from),
          //   user: user,
          //   id,
          // });
        } else if (portnum === 71) {
          const neighbourInfo = NeighborInfo.decode(
            envelope.packet.decoded.payload,
          );

          const pni = prettyNeighbourInfo(neighbourInfo);
          const from = envelope.packet.from.toString(16);

          // console.log("neighbourInfo", neighbourInfo);
          // console.log("prettyNeighbourInfo", pni);

          // console.log("NEIGHBORINFO_APP", {
          //   from: prettyNodeName(from),
          //   neighbour_info: pni,
          //   id,
          // });
        } else if (portnum === 70) {
          const routeDiscovery = RouteDiscovery.decode(
            envelope.packet.decoded.payload,
          );

          const from = envelope.packet.from.toString(16);
          // console.log("TRACEROUTE_APP", {
          //   from: prettyNodeName(from),
          //   route_discovery: prettyRouteDiscovery(routeDiscovery),
          //   id,
          // });
        } else if (portnum === 5) {
          const routing = Routing.decode(envelope.packet.decoded.payload);
          // console.log(routing);
        } else {
          // console.log("portnum", portnum);
        }
      }
    }
  } catch (err) {
    console.log(err);
  }
});

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
