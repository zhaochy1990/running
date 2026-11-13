// 确认兑换商品图回归：运行真实点击/开抽屉逻辑，并检查 WXML 图片绑定。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../pages/points-mall/points-mall.ts', import.meta.url), 'utf8');
const wxml = readFileSync(new URL('../pages/points-mall/points-mall.wxml', import.meta.url), 'utf8');
const product = {
  id: 1, name: '能量胶', imageUrl: 'https://example.com/gel.png', price: 75,
  limit: 0, redeemed: 0, soldOut: false, limitHit: false, bySku: false, skus: [],
};
interface TestPage {
  data: Record<string, unknown>;
  setData(data: Record<string, unknown>): void;
  onRedeemTap(event: { currentTarget: { dataset: { pid: number } } }): void;
  onSheetClose(): void;
}
let page: TestPage | undefined;
runInNewContext(ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, {
  exports: {},
  require: () => ({ newIdempotencyKey: () => 'test-key' }),
  Page(options: TestPage) {
    page = options;
    page.setData = (data) => Object.assign(page!.data, data);
  },
});
assert.ok(page);
page.data.products = [product];
page.onRedeemTap({ currentTarget: { dataset: { pid: 1 } } });
assert.equal(page.data.sheetVisible, true);
assert.equal(page.data.sheetImageUrl, product.imageUrl, '确认兑换应使用所选商品图片');
assert.match(wxml, /<image\b[^>]*wx:if="{{sheetImageUrl}}"[^>]*class="sprod__img"[^>]*src="{{sheetImageUrl}}"[^>]*mode="aspectFill"/);
assert.match(wxml, /<view\b[^>]*wx:else[^>]*class="sprod__img"/);

// 换商品后更新图片；无图商品不得残留上次图片。
for (const imageUrl of ['https://example.com/shirt.png', '']) {
  page.onSheetClose();
  product.imageUrl = imageUrl;
  page.onRedeemTap({ currentTarget: { dataset: { pid: 1 } } });
  assert.equal(page.data.sheetImageUrl, imageUrl);
}
console.log('pointsMall.check: all assertions passed');
