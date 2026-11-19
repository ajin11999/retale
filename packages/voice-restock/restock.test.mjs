import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const html = readFileSync(new URL("index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function openApp(storage = new Map(), SpeechRecognition) {
  const elements = new Map();
  const context = createContext({
    document: {
      addEventListener() {},
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          style: {},
          classList: { add() {}, remove() {}, contains() { return false; } },
          addEventListener() {}
        });
        return elements.get(id);
      }
    },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    navigator: { userAgent: "" }, window: { SpeechRecognition }, setTimeout() {}, clearTimeout() {}
  });
  runInContext(script, context);
  runInContext("state.ttsEnabled = false", context);
  return {
    say: line => context.parseAndExecuteSpeech(line),
    section: () => context.getActiveSection(),
    order: () => context.generatePlainText(),
    undo: () => context.undoLastInActive(),
    toggleMic: () => context.toggleListening(),
    nextSection: () => context.nextSection()
  };
}

test("supported size and piece formats survive through to order export", () => {
  for (const [phrase, lines] of [
    ["twenty-five equals fifteen pieces.", ["25 = 15"]],
    ["10 = 100 pcs", ["10 = 100"]],
    ["20, 100", ["20 = 100"]],
    ["thirty fifty pieces", ["30 = 50"]],
    ["12.5 mm x 1,000 pcs", ["12.5 = 1000"]],
    ["40 is one hundred and twenty-five pieces", ["40 = 125"]],
    ["20 is 100 and 30 is 50", ["20 = 100", "30 = 50"]],
    ["20 is one hundred and thirty is fifty", ["20 = 100", "30 = 50"]],
    ["10 is ten, then 20 equals one thousand and five.", ["10 = 10", "20 = 1005"]],
    ["10 = 4; 15 = 6\n20 = 9", ["10 = 4", "15 = 6", "20 = 9"]]
  ]) {
    const app = openApp();
    app.say(phrase);
    assert.deepEqual(app.order().split("\n").slice(1), lines.map(line => "- " + line + " pcs"), phrase);
    assert.equal(app.section().unparsed.length, 0);
  }
});

test("an incomplete or ambiguous utterance queues the entire original without changing the order", () => {
  const app = openApp();
  app.say("25 equals 15");
  const previous = app.order();
  for (const line of [
    "25 equals 2.5 pieces", "25 equals 1/2", "25 equals -5", "25 equals 0",
    "twenty five", "25 equals", "25 equals 2 to 5", "25 equals 15 and 30 equals bananas",
    "25 equals 2 1/2 pieces", "25 equals zero thousand",
    "NTN 6201 equals four pieces", "25 equals 1 pack", "25 equals 9007199254740992"
  ]) {
    app.say(line);
    assert.equal(app.order(), previous, line);
    assert.equal(app.section().unparsed[0].text, line);
  }
});

test("undo restores earlier quantities by section, including after a reload", () => {
  const storage = new Map();
  const first = openApp(storage);
  first.say("25 equals 15");
  first.say("25 equals 5");
  assert.equal(first.section().items[0].qty, 20);
  first.say("next section.");
  first.say("25 equals 50");
  const reopened = openApp(storage);
  reopened.say("undo.");
  assert.equal(reopened.section().items.length, 0);
  assert.match(reopened.order(), /25 = 20 pcs$/);
  for (let i = 0; i < 3; i++) reopened.say("next section");
  reopened.undo();
  assert.match(reopened.order(), /25 = 15 pcs$/);
});

test("a later pair overflowing an accumulated count leaves every line untouched", () => {
  const app = openApp();
  app.say("25 equals 9007199254740990");
  const previous = app.order();
  app.say("30 equals 1 and 25 equals 1 and 25 equals 1");
  assert.equal(app.order(), previous);
  assert.equal(app.section().unparsed.length, 1);
});

test("browser result indices distinguish interim updates, duplicate finals and repeated orders", () => {
  let mic;
  class Recognition {
    constructor() { mic = this; }
    start() { this.rows = []; }
    stop() { this.stopped = true; }
    emit(index, transcript, isFinal = true) {
      this.rows[index] = Object.assign([{ transcript }], { isFinal });
      this.onresult({ resultIndex: index, results: this.rows });
    }
  }
  const app = openApp(new Map(), Recognition);
  app.toggleMic();
  mic.emit(0, "25 equals", false);
  assert.equal(app.section().items.length, 0);
  mic.emit(0, "25 equals 15");
  mic.emit(0, "25 equals 15.");
  assert.equal(app.section().items[0].qty, 15);
  mic.emit(1, "25 equals 15");
  assert.equal(app.section().items[0].qty, 30);
  app.nextSection();
  assert.equal(mic.stopped, true);
  mic.emit(2, "30 equals 10");
  assert.equal(app.section().items.length, 0);
  assert.match(app.order(), /## M6[^#]+30 = 10 pcs$/);
});
