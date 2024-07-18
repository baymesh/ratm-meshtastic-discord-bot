/*
MeshPacket {
  from: 2714925544,
  to: 2701269827,
  channel: 8,
  encrypted: <Buffer 8d 53 70 73 df 7a 9d 6b d9 cb a8 3e 22 85 78 0c 21>,
  id: 2453211154,
  rxTime: 1716065361,
  rxSnr: 10.25,
  hopLimit: 1,
  wantAck: true,
  rxRssi: -79,
  hopStart: 3,
  decoded: Data {
    portnum: 1,
    payload: <Buffer 53 61 74 75 72 64 61 79 20 74 65 73 74>
  }
}
*/

export interface Data {
  portnum: number;
  payload: Buffer;
}

export interface MeshPacket {
  from: number;
  to: number;
  channel: number;
  encrypted: Buffer;
  id: number;
  rxTime: number;
  rxSnr: number;
  hopLimit: number;
  wantAck: boolean;
  rxRssi: number;
  hopStart: number;
  decoded: Data;
}

export interface ServiceEnvelope {
  packet: MeshPacket;
  mqttTime: Date;
  channelId: string;
  gatewayId: string;
  topic: string;
  mqttServer: string;
}

export interface PacketGroup {
  id: number;
  time: Date;
  rxTime: number;
  serviceEnvelopes: ServiceEnvelope[];
}

class MeshPacketQueue {
  queue: PacketGroup[];

  constructor() {
    this.queue = [];
  }

  exists(packetId: number): boolean {
    return this.queue.some((packetGroup) => packetGroup.id === packetId);
  }

  getIndex(packetId: number): number {
    return this.queue.findIndex((packetGroup) => packetGroup.id === packetId);
  }

  add(serviceEnvelope: ServiceEnvelope, topic: string, mqttServer: string) {
    serviceEnvelope.mqttTime = new Date();
    serviceEnvelope.topic = topic;
    serviceEnvelope.mqttServer = mqttServer;
    const grouptIndex = this.getIndex(serviceEnvelope.packet.id);
    if (grouptIndex === -1) {
      this.queue.push({
        id: serviceEnvelope.packet.id,
        time: serviceEnvelope.mqttTime,
        rxTime: serviceEnvelope.packet.rxTime,
        serviceEnvelopes: [serviceEnvelope],
      });
    } else {
      this.queue[grouptIndex].serviceEnvelopes.push(serviceEnvelope);
    }
  }

  popPacketGroupsOlderThan(time: number): PacketGroup[] {
    const packetGroups = this.queue.filter(
      (packetGroup) => packetGroup.time.getTime() < time,
    );
    this.queue = this.queue.filter(
      (packetGroup) => packetGroup.time.getTime() >= time,
    );
    return packetGroups;
  }

  size() {
    return this.queue.length;
  }
}

export default MeshPacketQueue;
