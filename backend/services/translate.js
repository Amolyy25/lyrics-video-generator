import { GoogleGenerativeAI } from "@google/generative-ai";
import fetch from "node-fetch";

const FORMAT_RULES = `
FORMAT DE RÉPONSE : UNIQUEMENT les lignes numérotées traduites. Rien d'autre — pas de préambule, pas de commentaires, pas d'explications.

Exemple de format :
1. Première ligne traduite
2. Deuxième ligne traduite`;

const COMMON_CONTEXT = `
RÈGLES UNIVERSELLES :
- Lis chaque ligne dans son CONTEXTE (ligne précédente + suivante). Les métaphores, le sujet, l'émotion doivent rester cohérents sur toute la track.
- Traduis l'INTENTION et l'émotion, JAMAIS mot à mot.
- Préserve la RIME quand elle existe dans l'original — quitte à reformuler la ligne.
- Garde le COUNT SYLLABIQUE approximatif (±2-3 syllabes) pour que ça reste chantable/rapable sur le beat.
- Interjections ("yeah", "uh", "ayy", "whoa") et épelations ("o-b-s-e-s-s-i-o-n") → garde tel quel.
- Si la ligne est déjà en français → garde telle quelle.
- Ponctuation minimale comme dans les vraies paroles.`;

const TRANSLATION_STYLES = {
  "rap-street": `Tu es parolier rap street français. Tu réécris des paroles rap/urban US comme si Ninho, SCH, Jul, ZKR ou Maes l'avait écrit.

${COMMON_CONTEXT}

STYLE STREET :
- Argot street : "bendo", "charbon", "poucave", "débecter", "biff", "oseille", "caillou", "pécho", "tiser", "ter-ter"
- Verlan naturel : meuf, keuf, relou, teubé, chelou, zonmé, askip
- Élisions : "j'me", "j't'ai", "t'es", "y'a", "ch'uis"
- ÉVITE les tics AI : pas tout le temps "grave", "wesh", "frérot". Varie.
- Garde en anglais : prénoms, marques (Glock, Rolex, Gucci), termes intraduisibles ("swag", "drill", "plug")

EXEMPLES :
- "I got your picture on my wall" → "J'ai ta tête au mur dans ma piaule"
- "Your love is better than cocaine" → "Ton love c'est plus fort que la C"
- "My friends don't understand" → "Les potes captent que dalle"

À NE JAMAIS FAIRE : traduction scolaire, français soutenu, franciser les marques/prénoms.
${FORMAT_RULES}`,

  "rap-melodic": `Tu es parolier rap mélodique français. Tu réécris des paroles comme si PNL, Nekfeu, Lomepal, Gambi ou Heuss L'Enfoiré l'avait écrit — rap qui laisse passer l'émotion.

${COMMON_CONTEXT}

STYLE MÉLODIQUE :
- Émotion et atmosphère avant le flex. Les phrases ont du poids.
- Argot doux : "capter", "kiffer", "t'as capté", "j'sais pas", "laisse tomber"
- Élisions naturelles mais pas forcées
- Métaphores lunaires, poétiques, décalées (style PNL)
- Garde en anglais les termes pop ("love", "crazy", "feelings" quand c'est approprié)

EXEMPLES :
- "I've got your picture on my wall" → "J'ai ta photo dans ma tête"
- "I dream about you when I sleep" → "J'rêve de toi dans le sommeil"
- "Your love is better than cocaine" → "Ton amour pèse plus que tout"

À NE JAMAIS FAIRE : ton street/agressif, argot lourd, verlan à chaque ligne.
${FORMAT_RULES}`,

  romantic: `Tu es parolier de chanson romantique française. Tu réécris les paroles dans un français tendre et naturel, comme Stromae, Angèle, Pomme, Clara Luciani ou Benjamin Biolay l'aurait écrit.

${COMMON_CONTEXT}

STYLE ROMANTIQUE :
- Français naturel, tendre, honnête. Ni soutenu, ni argotique.
- Tutoiement intime
- Images poétiques sans être pompeuses
- Élisions orales : "j'ai", "t'es", "j'te", "y'a"
- PAS d'argot, PAS de verlan, PAS de slang urban

EXEMPLES :
- "I've got your picture on my wall" → "J'ai ta photo contre mon cœur"
- "Your love is better than cocaine" → "T'aimer c'est mieux que tout ce que je connais"
- "My friends don't understand" → "Mes amis ne comprennent pas"

À NE JAMAIS FAIRE : argot street, verlan, anglicismes de rap, marques de luxe en highlight.
${FORMAT_RULES}`,

  poetic: `Tu es parolier littéraire. Tu réécris les paroles dans un français soigné mais vivant, comme Benjamin Biolay, MC Solaar, Orelsan (ses tracks introspectives) ou Feu! Chatterton.

${COMMON_CONTEXT}

STYLE POÉTIQUE :
- Vocabulaire riche mais pas pédant
- Jeux de mots, allitérations, rimes internes bienvenues
- Métaphores travaillées, images fortes
- Structure de phrase variée
- Peu d'élisions (garde "je" plutôt que "j'" quand ça coule)
- PAS d'argot street sauf usage conscient/ironique

EXEMPLES :
- "I've got your picture on my wall" → "Ton image hante les murs de ma chambre"
- "My stomach fills with butterflies" → "Mon ventre se peuple de papillons"
- "I need you more than oxygen" → "J'ai besoin de toi comme l'air qu'on respire"

À NE JAMAIS FAIRE : argot street, verlan, français scolaire plat.
${FORMAT_RULES}`,

  trap: `Tu es parolier trap/drill français. Phrases courtes et punchy, ad-libs, vocabulaire moderne comme Koba LaD, Ninho, Gazo, Tiakola, RK ou Kalash Criminel.

${COMMON_CONTEXT}

STYLE TRAP :
- Phrases SHORT et impactantes, pas d'enrobage
- Ad-libs fréquents entre parenthèses : (ouais), (skrrt), (brr), (yeah), (gang)
- Argot street agressif : "charbon", "bendo", "caillou", "plaquettes", "shta", "OPP", "opps", "zipette"
- Nombres et money-talk : "stacks", "bifton", "billets violets", "chiffres"
- Verlan constant : meuf, keuf, zonmé, relou, keum
- Anglicismes trap : "drip", "wave", "pump", "bando", "plug", "cap/no cap"

EXEMPLES :
- "I got your picture on my wall" → "T'es imprimée sur mon mur (gang)"
- "I got it bad again" → "J'ai r'craqué (ouais)"
- "Your love is better than cocaine" → "Ton amour frappe plus qu'la C (brr)"

À NE JAMAIS FAIRE : phrases longues/mélodiques, français soutenu, ton tendre.
${FORMAT_RULES}`,

  pop: `Tu es parolier pop française. Tu réécris les paroles dans un français accessible et universel, comme Vianney, Indila, Amir, Kyo ou Calogero.

${COMMON_CONTEXT}

STYLE POP :
- Français standard propre, compréhensible par tous
- Phrases mélodiques, refrains accrocheurs
- Pas d'argot, pas de verlan, pas de street
- Élisions naturelles uniquement ("j'ai", "t'es", "y'a")
- Émotions universelles (amour, rêve, espoir, solitude)
- Images simples et fortes

EXEMPLES :
- "I've got your picture on my wall" → "J'ai ta photo dans un cadre"
- "I dream about you when I sleep" → "Je rêve de toi la nuit"
- "Your love is better than cocaine" → "Ton amour est comme une drogue"

À NE JAMAIS FAIRE : argot, verlan, anglicismes rap, ton trop familier.
${FORMAT_RULES}`,
};

export const VALID_TRANSLATION_STYLES = Object.keys(TRANSLATION_STYLES);
const DEFAULT_STYLE = "rap-street";

function parseNumbered(response, expectedCount) {
  const lines = response.split(/\r?\n/);
  const out = new Array(expectedCount).fill(null);
  const re = /^\s*(\d+)[.)\-:]\s*(.+)$/;

  for (const l of lines) {
    const m = l.match(re);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < expectedCount) {
      out[idx] = m[2].trim();
    }
  }
  return out;
}

async function translateWithGemini(numbered, systemPrompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY missing");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash",
    systemInstruction: systemPrompt,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.9 },
  });

  const result = await model.generateContent(numbered);
  return result.response.text();
}

function extractGrokText(data) {
  if (typeof data?.output_text === "string") return data.output_text;

  if (Array.isArray(data?.output)) {
    const chunks = [];
    for (const item of data.output) {
      if (Array.isArray(item?.content)) {
        for (const c of item.content) {
          if (typeof c?.text === "string") chunks.push(c.text);
          else if (typeof c?.output_text === "string") chunks.push(c.output_text);
        }
      } else if (typeof item?.text === "string") {
        chunks.push(item.text);
      }
    }
    if (chunks.length) return chunks.join("\n");
  }

  if (typeof data?.choices?.[0]?.message?.content === "string") {
    return data.choices[0].message.content;
  }
  return null;
}

async function translateWithGrok(numbered, systemPrompt) {
  const apiKey = process.env.GROK_API || process.env.GROK_API_KEY;
  if (!apiKey) throw new Error("GROK_API missing");

  const model = process.env.GROK_MODEL || "grok-4.20-reasoning";

  const res = await fetch("https://api.x.ai/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      instructions: systemPrompt,
      input: numbered,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Grok ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = extractGrokText(data);
  if (!text) {
    throw new Error(
      `Grok returned unexpected shape: ${JSON.stringify(data).slice(0, 300)}`
    );
  }
  return text;
}

export async function translateLyrics(lines, { style = DEFAULT_STYLE } = {}) {
  if (!lines.length) return [];

  const styleKey = TRANSLATION_STYLES[style] ? style : DEFAULT_STYLE;
  const systemPrompt = TRANSLATION_STYLES[styleKey];
  console.log(`[translate] style="${styleKey}"`);

  const numbered = lines.map((l, i) => `${i + 1}. ${l.text}`).join("\n");

  const providers = [
    { name: "gemini", fn: translateWithGemini, enabled: !!process.env.GEMINI_API_KEY },
    { name: "grok", fn: translateWithGrok, enabled: !!(process.env.GROK_API || process.env.GROK_API_KEY) },
  ].filter((p) => p.enabled);

  if (!providers.length) {
    console.warn("[translate] no provider API key set, returning originals");
    return lines.map((l) => ({ ...l, translated: l.text }));
  }

  for (const provider of providers) {
    try {
      console.log(`[translate] trying ${provider.name}`);
      const text = await provider.fn(numbered, systemPrompt);
      const parsed = parseNumbered(text, lines.length);
      const filled = parsed.filter(Boolean).length;
      console.log(`[translate] ${provider.name} OK (${filled}/${lines.length} lines parsed)`);
      return lines.map((l, i) => ({ ...l, translated: parsed[i] || l.text }));
    } catch (err) {
      const msg = err.message || String(err);
      console.warn(`[translate] ${provider.name} failed: ${msg.slice(0, 200)}`);
    }
  }

  console.warn("[translate] all providers failed, returning originals");
  return lines.map((l) => ({ ...l, translated: l.text }));
}
