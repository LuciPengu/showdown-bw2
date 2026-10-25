// BW2's server commands: what the battle logic sends the battle client to play.
// Numbers and argument packing follow pokebw2's include/battle/btl_server_cmd.h
// and src/ov167/btl_server_cmd.c (https://github.com/fuddlesworth/pokebw2).

/** Server command numbers, in pokebw2's enum order. MSG_STD/MSG_SET take a message ID, then its arguments. */
export const SC = {
  NULL: 0x00,
  OP_SUBTRACT_HP: 0x01,
  OP_ADD_HP: 0x02,
  OP_ZERO_HP: 0x03,
  OP_SUBTRACT_PP: 0x04,
  OP_SUBTRACT_ORIGINAL_PP: 0x05,
  OP_SET_MOVE_USED: 0x06,
  OP_ADD_PP: 0x07,
  OP_ADD_ORIGINAL_PP: 0x08,
  OP_RAISE_STAT_STAGE: 0x09,
  OP_LOWER_STAT_STAGE: 0x0a,
  OP_SET_STAT_STAGES: 0x0b,
  OP_RECOVER_STAT_STAGES: 0x0c,
  OP_RESET_STAT_STAGES: 0x0d,
  OP_ADD_CRIT_STAGE: 0x0e,
  OP_SET_CONDITION: 0x0f,
  OP_CURE_CONDITION: 0x10,
  OP_CURE_MOVE_CONDITION: 0x11,
  OP_SEND_IN: 0x12,
  OP_SET_BASE_STAT: 0x13,
  OP_SET_WEIGHT: 0x14,
  OP_CONDITION_TURN_CHECK: 0x15,
  OP_CHANGE_TYPE: 0x16,
  OP_CONSUME_ITEM: 0x17,
  OP_UPDATE_USED_MOVE: 0x18,
  OP_SET_CONDITION_FLAG: 0x19,
  OP_CLEAR_CONDITION_FLAG: 0x1a,
  OP_SET_TURN_FLAG: 0x1b,
  OP_CLEAR_TURN_FLAG: 0x1c,
  OP_CHANGE_ABILITY: 0x1d,
  OP_SET_ITEM: 0x1e,
  OP_UPDATE_MOVE: 0x1f,
  OP_CLEAR_FOR_SWITCH: 0x20,
  OP_ADD_FIELD_EFFECT: 0x21,
  OP_ADD_FIELD_EFFECT_DEPEND_MON: 0x22,
  OP_REMOVE_FIELD_EFFECT_DEPEND_MON: 0x23,
  OP_REMOVE_FIELD_EFFECT: 0x24,
  OP_SET_COUNTER: 0x25,
  OP_BATON_PASS: 0x26,
  OP_CREATE_SUBSTITUTE: 0x27,
  OP_DELETE_SUBSTITUTE: 0x28,
  OP_ADD_SHOOTER_ENERGY: 0x29,
  OP_SETUP_ILLUSION: 0x2a,
  OP_CLEAR_CONSUMED_ITEM: 0x2b,
  OP_CURE_MON_DEPENDENT_CONDITIONS: 0x2c,
  OP_ADD_DAMAGE_RECORD: 0x2d,
  OP_TURN_CHECK: 0x2e,
  OP_FIELD_TURN_CHECK: 0x2f,
  MOVE_ANIM: 0x30,
  SET_MON_VISIBLE: 0x31,
  DAMAGE: 0x32,
  DAMAGE_PLURAL: 0x33,
  ONE_HIT_KO: 0x34,
  SET_GAUGE_STATUS: 0x35,
  CONFUSION_DAMAGE: 0x36,
  STAT_UP_EFFECT: 0x37,
  STAT_DOWN_EFFECT: 0x38,
  FAINT: 0x39,
  SHOW_MON: 0x3a,
  RECALL_MSG: 0x3b,
  RECALL: 0x3c,
  SEND_OUT: 0x3d,
  ADD_EVS: 0x3e,
  WEATHER_START: 0x3f,
  WEATHER_END: 0x40,
  UPDATE_HP_GAUGE: 0x41,
  USE_HELD_ITEM: 0x42,
  FAINT_HP_GAUGE: 0x43,
  SWAP_POS: 0x44,
  EXP_GAIN: 0x45,
  BALL_THROW: 0x46,
  BALL_THROW_TRAINER: 0x47,
  ROTATION: 0x48,
  CHANGE_ABILITY: 0x49,
  SWAP_ABILITY: 0x4a,
  ILLUSION_BREAK: 0x4b,
  EFFECT: 0x4c,
  EFFECT_BY_POS: 0x4d,
  EFFECT_BETWEEN_POS: 0x4e,
  CHANGE_FORM: 0x4f,
  MOVE_TO_CENTER: 0x50,
  SUBSTITUTE_CREATE: 0x51,
  SUBSTITUTE_DELETE: 0x52,
  TRANSFORM: 0x53,
  DAMAGE_EFFECT: 0x54,
  PLAY_BGM: 0x55,
  HIDE_MSG_WINDOW: 0x56,
  ABILITY_POPUP_IN: 0x57,
  ABILITY_POPUP_OUT: 0x58,
  MOVE_MSG: 0x59,
  MSG_STD: 0x5a,
  MSG_SET: 0x5b,
  MSG_STD_SE: 0x5c,
  MSG_SET_SE: 0x5d,
  NONE: 0x5e,
  RESERVE: 0x5f,
} as const;

/**
 * Argument formats. The names give each argument's width in bits, packed high
 * bits first; U8/U16/U32 are whole big-endian fields.
 */
type Format =
  | 'NONE' | 'U8' | 'U16' | 'U8_U8' | 'U8_U16' | 'U8_U32' | '4_4' | '5_3' | '5_3_U8' | '5_3_U16' | '5_5_5'
  | '5_5_14' | 'U8_U8_U16' | 'U8_U8_U32' | '5_3_U8_U16' | '5_3_5_3' | '5_5_14_U8' | '5_5_14_U16' | '5_5_6_U16'
  | 'U8_U8_U16_U16' | '5_5_5_U16_U16' | '5_3_7_1_U16' | '3_3_1_1_U16' | '5_5_5_5_5_5' | '3_2_1_1_1_U16'
  | '5_5_5_5_U16_U16' | 'U8X7' | 'U8X8';

/** Each command's format, by command number (the table at 0x021d6e50). Messages (0x5a–0x5d) aren't here. */
const FORMATS: Format[] = [
  'NONE', 'U8_U16', 'U8_U16', 'U8', '5_3_U8', '5_3_U8', '5_3', '5_3_U8', '5_3_U8', '5_3_U8', '5_3_U8', 'U8X8', 'U8',
  'U8', 'U8_U32', 'U8_U8_U32', 'U8', 'U8_U16', '5_3_U8_U16', '5_5_14', 'U8_U16', 'U8_U8_U32', 'U8_U16', 'U8_U16',
  '5_5_5_5_U16_U16', 'U8_U8', 'U8_U8', 'U8_U8', 'U8_U8', 'U8_U16', 'U8_U16', '5_3_7_1_U16', 'U8', 'U8_U32', 'U8_U8',
  'U8', 'U8', '5_5_14', 'U8_U8', 'U8_U16', 'U8', '4_4', 'U8', 'U8', 'U8_U8', '5_5_5_5_U16_U16', 'U8', 'U8',
  // 0x30: the commands that show something
  '5_5_14_U8', '5_3', 'U8_U8_U16', 'U8_U8_U16', 'U8', 'U8_U8', 'U8', '5_5_5', '5_5_5', 'U8', 'U8', 'U8_U8', 'U8_U16',
  '5_3_5_3', 'U8X7', 'U8_U8', 'U8', 'U8', 'U8', '5_3', '5_5_5', 'U8_U32', '3_2_1_1_1_U16', 'U8_U16', '4_4', 'U8_U16',
  'U8_U8_U16_U16', 'U8', 'U16', 'U8_U16', 'U8_U8_U16', 'U8_U8', '5_3_5_3', 'U8', 'U8', 'U8_U8', '5_3_U16', 'U16', 'U8',
  'U8', 'U8', 'U8_U16',
];

/** The most a command block can hold: the client's queue is 3000 bytes. */
export const MAX_BLOCK = 3000;

class Writer {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u24(v: number) {
    this.u8(v >> 16);
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v: number) {
    this.u16(v >>> 16);
    this.u16(v);
  }
}

/** Ends a message command's arguments (SC_MSG_ARG_END). */
const MSG_ARG_END = 0xffff0000;

function put(w: Writer, cmd: number, a: number[]): void {
  if (cmd === SC.MSG_STD || cmd === SC.MSG_SET) {
    // BtlServerCmdQueue_PutMsg: the message as a halfword, then each argument as a word, then the end marker
    const [message, ...args] = a;
    if (message === undefined || args.length > 14) throw new Error('a message takes an ID and up to 14 arguments');
    w.u16(cmd);
    w.u16(message);
    for (const arg of args) w.u32(arg);
    w.u32(MSG_ARG_END);
    return;
  }
  if (cmd === SC.DAMAGE_PLURAL) {
    // ServerDisplay_Damage: count, effectiveness, move, then a byte per Pokémon hit
    const [count, kind, move, ...monIds] = a;
    if (monIds.length !== count) throw new Error(`DAMAGE_PLURAL names ${count} Pokémon, got ${monIds.length}`);
    w.u16(cmd);
    w.u8(count);
    w.u8(kind);
    w.u16(move);
    for (const id of monIds) w.u8(id);
    return;
  }
  const format = FORMATS[cmd];
  if (format === undefined) throw new Error(`server command 0x${cmd.toString(16)} isn't supported`);
  const want = format === 'NONE' ? 0 : format.split('_').reduce((n, part) => n + (part.startsWith('U8X') ? Number(part.slice(3)) : 1), 0);
  if (a.length !== want) throw new Error(`server command 0x${cmd.toString(16)} takes ${want} arguments, got ${a.length}`);
  const b = (v: number, bits: number) => v & ((1 << bits) - 1);
  w.u16(cmd);
  switch (format) {
    case 'NONE': break;
    case 'U8': w.u8(a[0]); break;
    case 'U16': w.u16(a[0]); break;
    case 'U8_U8': w.u8(a[0]); w.u8(a[1]); break;
    case 'U8_U16': w.u8(a[0]); w.u16(a[1]); break;
    case 'U8_U32': w.u8(a[0]); w.u32(a[1]); break;
    case '4_4': w.u8((b(a[0], 4) << 4) | b(a[1], 4)); break;
    case '5_3': w.u8((b(a[0], 5) << 3) | b(a[1], 3)); break;
    case '5_3_U8': w.u8((b(a[0], 5) << 3) | b(a[1], 3)); w.u8(a[2]); break;
    case '5_3_U16': w.u8((b(a[0], 5) << 3) | b(a[1], 3)); w.u16(a[2]); break;
    case '5_5_5': w.u16((b(a[0], 5) << 10) | (b(a[1], 5) << 5) | b(a[2], 5)); break;
    case '5_5_14': w.u24((b(a[0], 5) << 19) | (b(a[1], 5) << 14) | b(a[2], 14)); break;
    case 'U8_U8_U16': w.u8(a[0]); w.u8(a[1]); w.u16(a[2]); break;
    case 'U8_U8_U32': w.u8(a[0]); w.u8(a[1]); w.u32(a[2]); break;
    case '5_3_5_3': w.u8((b(a[0], 5) << 3) | b(a[1], 3)); w.u8((b(a[2], 5) << 3) | b(a[3], 3)); break;
    case '5_3_U8_U16': w.u8((b(a[0], 5) << 3) | b(a[1], 3)); w.u8(a[2]); w.u16(a[3]); break;
    case '5_5_14_U8': w.u24((b(a[0], 5) << 19) | (b(a[1], 5) << 14) | b(a[2], 14)); w.u8(a[3]); break;
    case '5_5_14_U16': w.u24((b(a[0], 5) << 19) | (b(a[1], 5) << 14) | b(a[2], 14)); w.u16(a[3]); break;
    case '5_5_6_U16': w.u16((b(a[0], 5) << 11) | (b(a[1], 5) << 6) | b(a[2], 6)); w.u16(a[3]); break;
    case 'U8_U8_U16_U16': w.u8(a[0]); w.u8(a[1]); w.u16(a[2]); w.u16(a[3]); break;
    case '5_5_5_U16_U16': w.u16((b(a[0], 5) << 10) | (b(a[1], 5) << 5) | b(a[2], 5)); w.u16(a[3]); w.u16(a[4]); break;
    case '5_3_7_1_U16':
      w.u16((b(a[0], 5) << 3) | b(a[1], 3));
      w.u16((b(a[2], 7) << 1) | b(a[3], 1));
      w.u16(a[4]);
      break;
    case '3_3_1_1_U16': w.u8((b(a[0], 3) << 5) | (b(a[1], 3) << 2) | (b(a[2], 1) << 1) | b(a[3], 1)); w.u16(a[4]); break;
    case '5_5_5_5_5_5':
      w.u16((b(a[0], 5) << 10) | (b(a[1], 5) << 5) | b(a[2], 5));
      w.u16((b(a[3], 5) << 10) | (b(a[4], 5) << 5) | b(a[5], 5));
      break;
    case '3_2_1_1_1_U16':
      w.u8((b(a[0], 3) << 5) | (b(a[1], 2) << 3) | (b(a[2], 1) << 2) | (b(a[3], 1) << 1) | b(a[4], 1));
      w.u16(a[5]);
      break;
    case '5_5_5_5_U16_U16':
      w.u24((b(a[0], 5) << 15) | (b(a[1], 5) << 10) | (b(a[2], 5) << 5) | b(a[3], 5));
      w.u16(a[4]);
      w.u16(a[5]);
      break;
    case 'U8X7':
    case 'U8X8':
      a.forEach((v) => w.u8(v));
      break;
  }
}

/** One command: its number, then its arguments in the order the game's Put takes them. */
export type ServerCmd = [cmd: number, ...args: number[]];

/**
 * Packs commands into a block for the client. The client copies blocks in
 * 4-byte words, so the end is padded with a RESERVE the reader skips.
 */
export function encodeBlock(cmds: ServerCmd[]): Uint8Array {
  const w = new Writer();
  for (const [cmd, ...args] of cmds) put(w, cmd, args);
  const rem = w.bytes.length % 4;
  if (rem) {
    const skip = (4 - ((rem + 3) % 4)) % 4; // RESERVE takes 3 bytes, then `skip` bytes of room
    w.u16(SC.RESERVE);
    w.u8(skip);
    for (let i = 0; i < skip; i++) w.u8(0);
  }
  if (w.bytes.length > MAX_BLOCK) throw new Error(`command block is ${w.bytes.length} bytes; the queue holds ${MAX_BLOCK}`);
  return Uint8Array.from(w.bytes);
}
