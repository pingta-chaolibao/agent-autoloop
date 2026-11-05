// Feishu (Lark), through the official lark-cli: it holds the app's credentials and the long connection that brings
// clicks back, so this machine needs no public address. Only one listener can hold an app's card clicks, so run this in
// one place.
//   "channels": { "feishu": { "key": "…", "user": "ou_xxx" } } in config.json
//   "channels": { "feishu": { "name": "飞书", "answerers": ["ou_xxx"] } } in rules.json: who may answer.
import { execFile, spawn } from "node:child_process";
import readline from "node:readline";
import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Card, ChannelContext } from "../../host/channels.ts";
import { programCommand } from "../../worker/agents.ts";
import { previewImage } from "../../worker/media.ts";
import { MEDIA_TYPES, parseAssets } from "../../protocol/media.ts";

function outcomeOf(card: Card) {
  const chosen = card.choice === null ? card.answer : card.options[card.choice];
  if (card.state === "decided") return `你选了「${chosen}」，已记录，等待处理。`;
  if (card.state === "done") return `你选了「${chosen}」。${card.result ? `已执行：${card.result}` : "已执行。"}`;
  if (card.state === "closed" && card.kind === "ask") return `不用决定了：${card.result ?? ""}`;
  return card.state === "closed" && card.result ? card.result : null;
}

/** One card, as it looks now: the options while it's open, what became of it after. */
export function render(card: Card) {
  const outcome = outcomeOf(card);
  // Each option is a block across the card, its words wrapping: buttons in a row, one line high, cut long options off.
  const option = (label: string, index: number) => ({
    tag: "interactive_container",
    width: "fill",
    has_border: true,
    border_color: index === card.recommend ? "blue" : "grey",
    corner_radius: "8px",
    padding: "8px 12px 8px 12px",
    behaviors: [{ type: "callback", value: { card: card.id, choice: index } }],
    elements: [{ tag: "div", text: { tag: "plain_text", content: label } }],
  });
  const afterwards = outcome ? [{ tag: "markdown", content: `**${outcome}**` }] : [];
  const textAnswer = {
    tag: "form",
    name: "answer_form",
    elements: [
      {
        tag: "input",
        name: "answer_text",
        input_type: "multiline_text",
        placeholder: { tag: "plain_text", content: "选项都不符合？写下你的说明或处理要求" },
        required: true,
        width: "fill",
      },
      {
        tag: "button",
        name: "submit_answer",
        text: { tag: "plain_text", content: "提交文字回答" },
        type: "primary",
        action_type: "form_submit",
        behaviors: [{ type: "callback", value: { card: card.id, action: "answer_text" } }],
      },
    ],
  };
  return {
    schema: "2.0",
    config: { update_multi: true, enable_forward: false },
    header: {
      title: { tag: "plain_text", content: card.title },
      template: card.state === "open" ? "blue" : card.state === "closed" ? "grey" : "green",
    },
    body: {
      elements: [
        ...(card.text ? [{ tag: "markdown", content: card.text }] : []),
        ...(card.state === "open" ? card.options.map(option) : afterwards),
        ...(card.state === "open" && card.kind === "ask" ? [textAnswer] : []),
      ],
    },
  };
}

export default async function feishu({ hub, options, directory, log, signal }: ChannelContext) {
  if (directory) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const program = (options.lark as string | undefined) ?? "lark-cli";
  const command = process.platform === "win32" ? programCommand(program) : [program];
  const lark = async (args: string[], input: string) => {
    const printed = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        command[0],
        [...command.slice(1), ...args],
        { encoding: "utf8", timeout: 60_000, signal, windowsHide: true, ...(directory && { cwd: directory }) },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
      child.stdin!.on("error", reject);
      child.stdin!.end(input);
    });
    const out = JSON.parse(printed);
    if (out.ok === false || out.error) {
      throw new Error(`lark-cli ${args.slice(0, 3).join(" ")}: ${JSON.stringify(out.error ?? out).slice(0, 300)}`);
    }
    return out;
  };
  const owner = (options.user as string | undefined) ?? (await lark(["auth", "status"], "")).identities?.user?.openId;
  if (!owner) throw new Error("飞书通道要在 config.json 写 user，或者先 lark-cli auth login");

  const updateMessage = (ref: string, content: string) =>
    lark(["im", "messages", "patch", "--message-id", ref, "--as", "bot", "--data", "-"], JSON.stringify({ content }));

  async function sendMessage(cardId: number, content: string) {
    const target = ["--user-id", owner, "--as", "bot", "--msg-type", "interactive"];
    // The key is the card alone, not its version: a report that got lost must not make a second message.
    const once = ["--idempotency-key", `agent-autoloop-card-${cardId}`];
    return (await lark(["im", "+messages-send", ...target, ...once, "--content", "-"], content)).data
      .message_id as string;
  }

  async function sendMedia(card: Card) {
    const assets = parseAssets(card.artifacts ?? []);
    if (!assets.length) return;
    if (!directory || !hub.cardAsset) throw new Error("Lark 通道需要附件缓存目录与下载接口");
    for (const asset of assets) {
      const filename = asset.id + MEDIA_TYPES[asset.type];
      const file = path.join(directory, filename);
      if (!existsSync(file)) {
        const bytes = await hub.cardAsset(card.id, asset.id);
        if (bytes.length !== asset.size) throw new Error("结果附件不完整");
        writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });
      } else if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink() || lstatSync(file).size !== asset.size)
        throw new Error("附件缓存无效");
      const target = [
        "im",
        "+messages-send",
        "--as",
        "bot",
        "--user-id",
        owner,
        "--idempotency-key",
        `autoloop-${card.id}-${asset.id.slice(0, 24)}`,
      ];
      if (asset.type.startsWith("image/")) await lark([...target, "--image", filename], "");
      else {
        const uploaded = await lark(
          ["im", "files", "create", "--as", "bot", "--data", "-", "--file", filename],
          JSON.stringify({ file_type: "mp4", file_name: asset.name }),
        );
        const key = uploaded.data.file_key;
        if (typeof key !== "string") throw new Error("Lark 没有返回影片文件编号");
        const cover = `${asset.id}.cover.png`;
        if (await previewImage(file, path.join(directory, cover)))
          await lark([...target, "--video", key, "--video-cover", cover], "");
        else await lark([...target, "--file", key], "");
      }
    }
  }

  async function deliver() {
    while (!signal.aborted) {
      let card: Card | null;
      try {
        ({ card } = await hub.nextCard(50));
      } catch (error) {
        log(`couldn't reach the hub: ${error}`);
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        continue;
      }
      if (!card) continue;
      try {
        const content = JSON.stringify(render(card));
        let ref = card.ref;
        if (ref) await updateMessage(ref, content);
        else {
          await sendMedia(card);
          ref = await sendMessage(card.id, content);
        }
        await hub.delivered(card.id, card.version, ref);
      } catch (error) {
        log(`card ${card.id} not sent: ${error}`);
        await hub.failed(card.id, card.version, String(error)).catch(() => {});
      }
    }
  }

  /** Buttons and form replies share the same owner/message checks and one-answer semantics in the hub. */
  async function clicked(line: string) {
    const event = JSON.parse(line);
    const value = JSON.parse(event.action_value);
    if (
      !Number.isInteger(value.card) ||
      value.card < 1 ||
      typeof event.operator_id !== "string" ||
      !event.operator_id.trim() ||
      typeof event.message_id !== "string" ||
      !event.message_id.trim()
    )
      return;
    let response: { text: string } | { choice: number };
    if (value.action === "answer_text") {
      const form = JSON.parse(event.form_value);
      const text = typeof form?.answer_text === "string" ? form.answer_text.trim() : "";
      if (!text) return;
      response = { text };
    } else if (Number.isInteger(value.choice)) response = { choice: value.choice };
    else return;
    const answer = await hub.answer(value.card, { ...response, by: event.operator_id, ref: event.message_id });
    log(`card ${value.card}: answered by ${event.operator_id}, ${answer.changed ? "counted" : "already settled"}`);
  }

  async function listen() {
    while (!signal.aborted) {
      // stdin stays open: lark-cli ends an unbounded consume when its stdin closes.
      const consume = spawn(
        command[0],
        [...command.slice(1), "event", "consume", "card.action.trigger", "--as", "bot"],
        {
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const stop = () => consume.kill();
      signal.addEventListener("abort", stop);
      readline.createInterface({ input: consume.stderr }).on("line", (line) => log(line));
      readline
        .createInterface({ input: consume.stdout })
        .on("line", (line) => void clicked(line).catch((error) => log(`click not handled: ${error}`)));
      await new Promise((resolve) => consume.on("close", resolve));
      signal.removeEventListener("abort", stop);
      if (!signal.aborted) {
        log("the click listener stopped; starting it again in 10 seconds");
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }
  }

  await Promise.all([deliver(), listen()]);
}
