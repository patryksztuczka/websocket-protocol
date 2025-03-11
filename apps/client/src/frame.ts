export class Frame {
  private fin: number;
  private rsv1: number = 0b0;
  private rsv2: number = 0b0;
  private rsv3: number = 0b0;
  private mask: number = 0b1;
  private opcode: number;
  private payloadLength: number;
  private extendedPayloadLength: number;
  private maskingKey: number;
  private payloadData: number;

  constructor(payload: string) {
    console.log("PAYLOAD", payload);
    console.log("FIN", 1);
    console.log("RSV1", 0);
    console.log("RSV2", 0);
    console.log("RSV3", 0);
    console.log("MASK", 1);
    console.log("OPCODE", 1);
    console.log("PAYLOAD LEN", payload.length, payload.length.toString(2));
    // console.log("EXT PAYLOAD LEN");
    console.log("MASKING KEY", 1);
    let binaryData = "";
    for (let i = 0; i < payload.length; i++) {
      const binary = payload[i].codePointAt(0)?.toString(2).padStart(8, "0");
      binaryData += binary;
    }
    console.log("PAYLOAD DATA", binaryData);
  }
}
