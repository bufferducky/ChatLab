import type { TopicSourceBlock } from './source'
import type { ChatTopicAnalysisGap } from '@openchatlab/shared-types'

// Remove whole messages rather than disguising individual words. These local rules reduce
// unsuitable input; the provider's content review remains authoritative.
const CONTENT_RISKS = [
  /政治|政党|政黨|政府|共产党|共產黨|中共|国安部|國安部|中南海|习近平|習近平|蔡奇|毛泽东|毛澤東|邓小平|鄧小平|六四|天安门|天安門|法轮|法輪|大纪元|大紀元|阿波罗网|阿波羅網|文昭|王剑|王劍|川普|特朗普|拜登|台独|台獨|港独|港獨|藏独|藏獨|反共|反华|反華|民主运动|民主運動|政变|政變|镇压|鎮壓|8964/iu,
  /色情|情色|淫秽|淫穢|嫖娼|卖淫|賣淫|约炮|約炮|援交|裸聊|裸照|成人视频|成人視頻|成人资源|成人資源|黄片|黃片|黄网|黃網|摸奶|摸胸|摸屁股|做爱|做愛|性交|口交|肛交|阴茎|陰莖|阴道|陰道|鸡巴|雞巴|强奸|強姦|性侵|性服务|性服務|性交易|招嫖|出台|摸唱|摸.{0,12}(?:奶|胸|屁股)/iu,
  /黑产|黑產|灰产|灰產|电诈|電詐|诈骗|詐騙|洗钱|洗錢|跑分|博彩|赌博|賭博|网赌|網賭|赌场|賭場|地下钱庄|地下錢莊|接码|接碼|代实名|代實名|远控|遠控|支付通道|黑U|假U|骗U|騙U|回流业务|回流業務|有料没车|有料沒車|有卡车|有卡車|码车|碼車|贩毒|販毒|毒品|枪支交易|槍支交易|人口贩卖|人口販賣|买卖银行卡|買賣銀行卡|出售银行卡|出售銀行卡|出售个人信息|出售個人信息|出售公民信息|银行卡四件套|銀行卡四件套/iu,
  /\b(?:politic\w*|communis\w*|porn\w*|nsfw|sex|sexting|prostitut\w*|sexual\w*|nudes?|rape|gambling|casino|money.?laundering|drug.?trafficking|human.?trafficking)\b|xijinping|tiananmen|falungong/iu,
]

const ADDITIONAL_REVIEW_RISKS =
  /傻逼|傻b|煞笔|煞筆|操你|草你|他妈|他媽|垃圾|滚蛋|滾蛋|去死|杀人|殺人|自杀|自殺|血腥|暴力|死亡|威胁|威脅|恐吓|恐嚇|仇恨|辱骂|辱罵|乳房|胸部|屁股|包养|包養|陪睡|卖身|賣身|招嫖|裸|屌|叼毛|\b(?:fuck\w*|shit|bitch|suicid\w*|kill\w*|violence|hate)\b/iu

export const CONTENT_REVIEW_BLOCKED_PREFIX = 'content_review_blocked:'

export function hasTopicContentRisk(text: string, strict = false): boolean {
  const normalized = text.normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/gu, '')
  const compact = normalized.replace(/\s+/gu, '')
  return (
    CONTENT_RISKS.some((pattern) => pattern.test(normalized) || pattern.test(compact)) ||
    (strict && (ADDITIONAL_REVIEW_RISKS.test(normalized) || ADDITIONAL_REVIEW_RISKS.test(compact)))
  )
}

export function filterTopicContext(text: string, strict = false): string {
  return strict || hasTopicContentRisk(text) ? '[Context omitted by content filter]' : text
}

export function filterTopicBlock(block: TopicSourceBlock, strict = false): TopicSourceBlock {
  return {
    ...block,
    messages: block.messages
      .filter((message) => !hasTopicContentRisk(message.content, strict))
      .map((message) => ({
        ...message,
        senderName: strict || hasTopicContentRisk(message.senderName) ? 'Member' : message.senderName,
      })),
  }
}

export function isContentInspectionError(error: unknown): boolean {
  return getContentReviewDiagnostic(error) !== null
}

export function getContentReviewDiagnostic(
  error: unknown
): Pick<ChatTopicAnalysisGap, 'reason' | 'providerCode' | 'requestId'> | null {
  const fields: Record<string, string> = {}
  const texts: string[] = []
  const seen = new Set<object>()
  function visit(value: unknown, depth: number) {
    if (depth > 5) return
    if (typeof value === 'string') {
      texts.push(value)
      try {
        visit(JSON.parse(value), depth + 1)
      } catch {
        /* Plain provider text. */
      }
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value)
      for (const key of [
        'code',
        'message',
        'request_id',
        'requestId',
        'RequestId',
        'Code',
        'Message',
        'body',
        'error',
        'cause',
      ]) {
        const item = (value as Record<string, unknown>)[key]
        if (typeof item === 'string') fields[key] = item
        visit(item, depth + 1)
      }
    }
  }
  visit(error, 0)
  const text = texts.join(' ')
  const code = text.match(/(?:[\w]+\.)*data_?inspection_?failed/iu)?.[0]
  if (!code) return null
  const requestId =
    fields.request_id ?? fields.requestId ?? fields.RequestId ?? text.match(/request[ _-]?id["'\s:=]+([\w-]+)/iu)?.[1]
  return {
    reason: /output text|output.*inappropriate|输出|輸出/iu.test(text)
      ? 'output_review'
      : /input text|input.*inappropriate|输入|輸入/iu.test(text)
        ? 'input_review'
        : 'content_review',
    providerCode: code,
    // Store identifiers only, never the provider's potentially echoed chat content.
    ...(/^[\w.:/-]{1,200}$/u.test(requestId ?? '') ? { requestId } : {}),
  }
}

export class TopicContentReviewBlockedError extends Error {
  readonly code = 'content_review_blocked'

  constructor(
    message: string,
    readonly diagnostic: NonNullable<ReturnType<typeof getContentReviewDiagnostic>>,
    cause: unknown
  ) {
    super(message, { cause })
  }
}
