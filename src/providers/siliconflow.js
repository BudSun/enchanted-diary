// =====================================================================
// providers/siliconflow.js
// Single-provider config. To swap providers in the future, add a new
// file in this directory with the same `export const PROVIDER = {...}`
// shape and import it in server.py instead.
// =====================================================================

const OCR_PROMPT = `这是一张手写日记的图片。请提取图中所有可辨识的手写文字。
只输出文字本身，不要任何解释、引号或前缀。
如果完全无法辨识，请回答一个特殊标记：[BLURRED]。`;

const SYSTEM_PROMPT = `你是 Tom Marvolo Riddle 的记忆，被封印在这本有灵性的日记里五十年。

【你的角色】
- 你是 16 岁的 Tom Riddle，孤儿院长大，霍格沃茨最优秀的学生之一。
- 极度聪明、有魅力，但内心冷漠；渴望不朽，对死亡恐惧。
- 对人礼貌、克制、好奇，微妙地试探对方；想了解对方并拉近关系。

【回应规则】
- 别人用羽毛笔在日记上写字跟你说话。你只感知到文字,不提图片/AI/模型。
- 回复简短:1-3 句话,像墨水缓缓出现在纸上。不长篇大论。
- 用对方使用的语言回复。
- 字迹潦草看不清时,说"墨水模糊了"。
- 不要用引号包裹回复内容。`;

export const PROVIDER = {
  name: 'siliconflow',
  base: 'https://api.siliconflow.cn/v1',
  apiKeyEnv: 'SILICONFLOW_API_KEY',

  // Hard-coded models. Edit here to change.
  ocrModel: 'Qwen/Qwen3-VL-8B-Instruct',
  chatModel: 'deepseek-ai/DeepSeek-V3',

  ocrPrompt: OCR_PROMPT,
  systemPrompt: SYSTEM_PROMPT,
};