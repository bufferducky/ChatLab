import assert from 'node:assert/strict'
import test from 'node:test'
import { parsePrice } from './parser'

/**
 * Fixtures follow the real wording of Chinese deal-hunting groups: homophone
 * currency words, Unicode variant digits, emoji money markers, coupon arithmetic
 * and tiered prices. Product names are rewritten; message structure is preserved.
 *
 * These cases guard the one behaviour this module owns: a wrong price turns into
 * a wrong push. Extracting a split price as the order price reports deals that
 * do not exist, and missing the final-paid tier reports no deal at all.
 */
const cases: Array<{ name: string; text: string; finalPrice: number | null }> = [
  { name: 'plain yuan price', text: '[photo] 46.7元!! 1、下单某电器 -(aB)/ Cb', finalPrice: 46.7 },
  { name: 'homophone currency word', text: '[photo] 叠补贴 10.7亓（2.5/盒） 速!!', finalPrice: 10.7 },
  {
    name: 'unicode variant digits with emoji marker',
    text: '[photo] 𝟐.𝟒💰/件某点心🚗 任选𝟕件💵𝟏𝟔.𝟗！线下很贵',
    finalPrice: 16.9,
  },
  { name: 'unit price suffix dropped', text: '[photo] 13元,折0.6/包!! 1、加1件 某抽纸', finalPrice: 13 },
  { name: 'coupon arithmetic yields net price', text: '[photo] 17-送3虹包=14元!! 1、加1件 某酱油', finalPrice: 14 },
  {
    name: 'final paid tier beats checkout price',
    text: '[photo] 速度锁!bug价了 - 先去领plus 800-80券 - 拍下154元-反50元补贴 到手💰104元',
    finalPrice: 104,
  },
  {
    name: 'multiple tiers keep the highest',
    text: '[photo] 159💰基础体检 459💰深度体检 569💰豪华体检 上搞快点',
    finalPrice: 569,
  },
  {
    name: 'red packet amount is not a product price',
    text: '每日领56元外卖虹包 http://dpurl.cn/abc',
    finalPrice: null,
  },
  {
    name: 'unit-price-only message yields nothing',
    text: '[photo] 拍6件，折3.9元/桶‼️ 1、加6件 某米线',
    finalPrice: null,
  },
  { name: 'spec digits are not prices', text: '[photo] 60g💰55!!️正装量 1️⃣55💰某面霜', finalPrice: 55 },
  { name: 'bracket price with checkout context', text: '[photo] 凑后【5.3】某零食 需叠加会员', finalPrice: 5.3 },
  {
    name: 'bracket option label is not a price',
    text: '[photo] 有限时礼金，339亓‼ 这个有【170可选】，速‼',
    finalPrice: 339,
  },
  { name: 'empty content', text: '', finalPrice: null },
  { name: 'no price at all', text: '[photo] 某群友：这个好用，大家看看', finalPrice: null },
]

for (const item of cases) {
  test(`parsePrice: ${item.name}`, () => {
    const result = parsePrice(item.text)
    assert.equal(result?.finalPrice ?? null, item.finalPrice, item.text)
  })
}

test('parsePrice keeps the original price for the notification chain', () => {
  const result = parsePrice('[photo] 原价299元 券后199元 某耳机')
  assert.equal(result?.finalPrice, 199)
  assert.equal(result?.originalPrice, 299)
  assert.equal(result?.tier, 1)
})

test('parsePrice exposes the link-free text so offsets stay aligned', () => {
  const withLink = '[photo] 某商品💰39 https://u.jd.com/short'
  const result = parsePrice(withLink)
  assert.equal(result?.finalPrice, 39)
  assert.equal(result?.source, 'emoji')
})
