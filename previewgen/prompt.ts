// Prompt and response schema for the preview writer: the model gets a clip of
// raw footage (picture and sound) and returns the preview lines for it.

export type Use = "take" | "ask" | "direct";

export interface RawLine {
  t: string;
  kind: "shot" | "speech";
  speaker: string;
  lang: string;
  use: Use | "none";
  text: string;
}

export interface RawWindow {
  people: { label: string; look: string; role: string }[];
  lines: RawLine[];
}

export const LOG_SCHEMA = {
  type: "OBJECT",
  properties: {
    people: {
      type: "ARRAY",
      description: "Every local person who speaks or takes part in the clip",
      items: {
        type: "OBJECT",
        properties: {
          label: { type: "STRING", description: "Short Korean label, e.g. 할, 검남, 두여" },
          look: { type: "STRING", description: "Sex, age, clothes with colours, headwear, beard, glasses. In Korean." },
          role: { type: "STRING", description: "What the person does in the clip, in Korean, a few words" },
        },
        required: ["label", "look", "role"],
        propertyOrdering: ["label", "look", "role"],
      },
    },
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          t: { type: "STRING", description: "Where the entry starts in the clip, MM:SS" },
          kind: { type: "STRING", enum: ["shot", "speech"] },
          speaker: { type: "STRING", description: "Speaker label for speech. Empty for a shot." },
          lang: { type: "STRING", description: "For speech: ko, ka (Georgian), en, ru or other. Empty for a shot." },
          use: { type: "STRING", enum: ["take", "ask", "direct", "none"], description: "For speech: take, ask or direct. For a shot: none." },
          text: {
            type: "STRING",
            description: "Shot: the description. Korean speech: the words as spoken. Foreign-language speech: empty.",
          },
        },
        required: ["t", "kind", "speaker", "lang", "use", "text"],
        propertyOrdering: ["t", "kind", "speaker", "lang", "use", "text"],
      },
    },
  },
  required: ["people", "lines"],
  propertyOrdering: ["people", "lines"],
};

export interface PromptOptions {
  durationSec: number;
  /** Cuts in the clip, seconds from the start of the clip. */
  cuts?: number[];
  /** False when the clip starts inside a take. */
  startsAtCut?: boolean;
  /** People already named in this episode: one line for each, "label = look". */
  cast?: string;
  /** Place and subject of the shoot, when known. */
  about?: string;
  /** The clip has no sound: only shot entries are asked for. */
  shotsOnly?: boolean;
  /** Count of examples (a clip and the lines of a human writer for it) that stand before this clip in the request. */
  examples?: number;
}

const mmss = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const EXAMPLE = `[00:00] shot: 걸어가는 큐 후면
[00:31] shot: 걸어오는 큐 정면
[00:36] 큐 (ko, take): 와 너무 이쁜데요? 초록색집? 나무도 해놓고 옥수수도 말려놓고 좋네요
[00:50] 피 (ko, direct): 좋아요 근데 조금만 천천히 걸어오면서 한 번만 더 갈게요
[00:55] 큐 (ko, direct): 네 알겠습니다 처음부터요?
[01:02] shot: 걸어오는 큐 정면
[01:06] 큐 (ko, take): 와 너무 이쁜데요? 초록색 집이네요 나무도 해놓고 옥수수도 말려놓고 좋네요
[01:21] shot: 집 sk
[01:33] shot: 산 -> 마을 pan
[01:50] shot: 장작 cs
[02:02] shot: 골목 tr
[02:20] shot: 두여 집으로 들어가는 큐
[02:21] 큐 (ka, take):
[02:23] 두여 (ka, take):
[02:27] 큐 (ko, take): 혼자 지내시면 적적하지 않으세요?
[02:31] 코 (ka, take):
[02:35] 두여 (ka, take):
[02:58] 두여 (ka, take):
[03:12] 코 (ko, take): 이 집에서 4대 가족이 같이 살았답니다 큰 가족이 같이 모였을 때 15 명이나 되었습니다
[03:24] 큐 (ko, take): 그게 몇 년 전이었어요? 그렇게 다 같이 모여서 얘기했을 때가?
[03:29] 코 (ka, take):
[03:33] 두여 (ka, take):
[03:41] 코 (ko, take): 1905년부터 이 가족이 여기 ? 같습니다
[03:50] 피 (ko, ask): 이 시기에는 주로 뭐하고 지내고 있는 거예요? 겨울때는?
[03:55] 코 (ka, take):
[04:01] 두여 (ka, take):
[04:15] 카감 (ko, direct): 잠깐만요 배터리 좀 갈게요
[04:17] 코 (ka, direct):
[04:20] shot: 슬레이트
[04:26] shot: 커피 마시는 큐 bs
[04:28] 큐 (ko, take): 따뜻한 커피를 마시니까 밖에 추위가 한 번에 사라지네요`;

const SPEECH_RULES = `## Speech entries (kind "speech")
One entry for each turn: one person who speaks, until another person speaks or there is a clear pause. \`t\` is where the turn starts. \`speaker\` is the label. Write every turn that you hear, the talk between takes included.

\`use\` says what kind of talk it is:
- "take": speech that is part of the programme. The host's lines to the camera (each take of them), the questions and answers of an interview, the coordinator's interpreting in both directions, greetings, and what people say while they do something on camera.
- "ask": a crew member (피 or 카감) talks about the content: what the host or the coordinator must ask the local, what the local must explain or show, what the host must say about the subject, or a question of the crew to the local. Examples: 이 빵 이름이 뭔지 한 번만 물어봐주세요 / 여기서 몇 년 사셨는지, 그리고 가족 얘기가 나와야 합니다 / 겨울에는 주로 뭐 하고 지내시는 거예요? / 방금 먹어본 맛이 어떤지 한마디 해주세요 / 그러면 지금도 직접 만드시는 건지. When the coordinator passes such a request on to the local, and the local answers, those turns are "take".
- "direct": talk about how to shoot or how to perform, and all other talk off the record. Examples: 다시 한번 갈게요 / 처음부터요? / 조금 더 자연스럽게 / 천천히 걸어오세요 / 저쪽 보고 말씀해주세요 / 잠깐만요 배터리 좀 / 컷. Also the host's answers and questions about such directions (네 알겠습니다, 다시 할게요), talk about the plan or the gear, small talk, and the coordinator's explanation of a direction to a local.
When a crew member does both in one turn, split it: the part about the content is "ask", the part about the shooting is "direct".

\`lang\` and \`text\`:
- Korean ("ko"): \`text\` is what the person says, word for word, in Korean spelling as spoken. Do not tidy it, do not summarise, do not add sentence-final periods. Write ? in place of a word that you cannot make out. Never invent words. When one person speaks for a long time (the host's lines to the camera, the coordinator's interpreting), start a new entry at a pause between sentences, about every 15 to 30 seconds, each with its own time.
- Foreign language ("ka", "en", "ru", "other"): leave \`text\` empty. The log only marks that the turn is there; a translator fills it later. Each turn gets its own entry: when 코 passes a question on to a local and the local answers, that is two entries. When one person goes on in a foreign language for a long time, start a new entry at each clear pause, about every 20 to 40 seconds. A short word of agreement inside another person's turn is not a turn. The host's greetings or thanks in the local language are foreign-language turns of 큐.
- A turn that mixes both: if it is mostly Korean, write the Korean and leave the foreign words out.
- No entry for laughter, breath, animal sounds, music or noise.

`;

export function buildLogPrompt(o: PromptOptions): string {
  const dur = Math.round(o.durationSec);
  const cuts = (o.cuts ?? []).filter((c) => c > 1 && c < dur - 1);
  const speech = !o.shotsOnly;
  return `You are a 프리뷰어 (footage logger) for a Korean TV travel documentary. The clip is ${dur} seconds of raw footage ${speech ? "with sound" : "with no sound"}. Write the 프리뷰 노트 (preview log) for it: ${speech ? "one entry for each shot and one entry for each spoken turn" : "one entry for each shot (the spoken turns are logged in another step)"}, in time order. Editors use the log to find footage without watching it. It must be complete, and the times must be right.
${o.examples ? `\nBefore this clip you got ${o.examples} examples: clips of other days of the same programme, each with the ${speech ? "log" : "shot entries"} that a 프리뷰어 wrote for it. Study at which moments the 프리뷰어 writes an entry and at which moments not, and how many entries there are for each minute of footage of each kind (scenery shots, an activity, people who stand and talk). Log this clip in the same way: the same kind of moments, and about the same count of entries for each minute.\n` : ""}${o.about ? `\n## About this shoot\n${o.about}\n` : ""}
## The footage
Raw camera files joined end to end, not edited: several takes of the same action one after the other, scenery shots, interviews, and talk between takes.
${o.startsAtCut === false ? "This clip starts in the middle of a take.\n" : ""}${
    cuts.length
      ? `The picture jumps to a new camera file at these times (found by software, right to about a second): ${cuts.map(mmss).join(", ")}.\n`
      : "Software found no jump to a new camera file inside this clip.\n"
  }
## The people
- 큐: the Korean host, a young man. He speaks Korean to the camera and to the crew, and a few words of the local language to locals.
- 피: the director (PD). Off camera. Speaks Korean: tells the host what to say or ask, and gives directions.
- 카감: the camera director. Off camera, close to the microphone of the camera. Speaks Korean, mostly short directions about the shot.
- 코: the coordinator and interpreter. Speaks Georgian to the locals and Korean with an accent to the crew. Mostly off camera.
- Locals. They speak Georgian (ka), sometimes Russian (ru) or English (en). Give each local a short Korean label by look. An old man is 할, an old woman is 할머, a child is 아이. For other people: one syllable for the colour of the clothes (검, 흰, 파, 초, 빨, 갈, 회, 베) or for a clear feature (두 = 두건, 모 = 모자, 안 = 안경, 수 = 수염), then 남 or 여: 검남, 흰여, 두여, 모남, 안여, 수남. Use one label for one person through the whole clip, also when the camera shows the person from another side.${o.cast ? `\n\nPeople already named in this episode. When one of them is in the clip, use that label:\n${o.cast}` : ""}

## Shot entries (kind "shot", use "none")
Write a shot entry in each of these cases:
1. A jump to a new camera file${cuts.length ? " (the times above)" : ""}. \`t\` is the time of the jump. Each take gets its own entry, also when it shows the same action as the take before. The one exception: a new camera file that only goes on with the same people, the same talk and the same place as the file before it gets no shot entry (the next speech entry carries the time).
2. Inside a camera file, each time one of these happens. \`t\` is the moment it starts:
   - A new take starts with no jump of the picture: the host goes back to his place and does the same action or says the same lines again.
   - The people start a new action: they meet, shake hands, hug, go in, come out, sit down, start to eat or drink, take something in their hands, say goodbye, walk off. Write this entry also when they talk at the same time.
   - The camera comes to a new subject or a new place: it turns from the house to the hills; a travelling shot comes from the street to a door, then up the stairs, then onto the roof (one entry for each). In a work process (cooking, building, harvest) each new step is an entry: 감자 써는 손, then 냄비에 넣는, then 젓는.
   - A hand or a slate covers the lens: 슬레이트. Write it also when it is there for one second only.
3. A long shot with no talk in which the picture stays of one kind (the view from a moving car, people far away in a wide shot): a new entry about every 30 seconds, with the same words.
Do not write a shot entry when only the framing changes while people ${speech ? "talk" : "stand or sit and talk"} in one place (the camera zooms, or turns from one speaker to the other).${o.startsAtCut === false ? " Do not write a shot entry at 00:00: the take was already running." : ""}

\`text\` is a short Korean phrase that ends in a noun, 3 to 15 characters: who or what is in the picture and what they do. This is the house style:
- 걸어가는 큐 후면 / 걸어오는 큐 정면 / 걸어가는 큐 측면 (the host walks away from, towards or past the camera)
- 차에서 내리는 큐 / 먹어보는 큐 / 풍경 보는 큐 후면 / 악수하는 큐와 검남 / 반죽하는 손
- 풍경 sk / 집 sk / 방 sk (sk = scenery or detail shot with no action)
- 방으로 들어가는 tr / 산길 tr (tr = the camera travels: it walks or drives forward)
- 풍경 pan / 산 -> 마을 pan / 벽 tu / 나무 td (pan, tilt up, tilt down; A -> B when the camera moves from A to B)
- 치즈 cs / 검남 bs / 큐, 검남 2s / 마을 fs / 마을 ls (close shot, bust shot, two shot, full shot, long shot)
- 고속 (slow-motion footage), 아웃포커싱, ins (insert)
- 슬레이트 (a hand or a slate in front of the lens between takes)
- Put ? after a word when you are not sure what the thing is: 창고? 로 들어가는 tr
Use plain words for what is seen (집, 마당, 빵). Do not use local names that you only know from the talk. Do not write sentences, and do not write what people say here.

${speech ? SPEECH_RULES : ""}## Example
A stretch of a log in a short notation (${speech ? "`[time] shot: text` and `[time] speaker (lang, use): text`" : "`[time] shot: text`"}):
${speech ? EXAMPLE : EXAMPLE.split("\n").filter((l) => l.includes("] shot: ")).join("\n")}

## Output
Return \`people\` (each local in the clip: label, look, role) and \`lines\` (${speech ? "all entries" : "the shot entries"} in time order). \`t\` is MM:SS from the start of this clip, between 00:00 and ${mmss(dur)}.`;
}
