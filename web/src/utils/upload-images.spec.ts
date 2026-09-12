/**
 * 图集上传互转的回归测试。
 *
 * 守的是一个**真实踩过的坑**（用户报的原话：「新增服务项目的时候传了图片但是展示不出来，
 * 编辑时新增的也不行」）：`LewUpload` 只把「以图片扩展名结尾」的 url 当图片渲染，
 * 而**刚上传成功**回填的那条路上漏了显示态归一化 ——
 * 于是「反显的旧图正常、新传的图是文件图标」，新建时整个图集都看不见。
 *
 * 因此这里对**两条产出路径**都断言同一件事：交给 `LewUpload` 的 `url` 必须能通过那条正则。
 */
import { describe, expect, it } from 'vitest';
import { stripDisplayImageUrl } from './image-url';
import { IMAGE_ACCEPT } from './upload-limits';
import {
  toImageUrls,
  toSingleImageUrl,
  toUploadItems,
  toUploadedItem,
} from './upload-images';

/** 照抄自 `lew-ui/dist/index.js` 的判定正则（lew-ui 改了这里要跟着改） */
const LEW_IMAGE_RE =
  /\.(?:jpg|jpeg|png|webp|bmp|gif|svg|tiff|ico|heif|jfif|pjpeg|pjp|avif)$/i;

/** 项目里真实的存储值 / 上传接口返回后拼出来的预览地址 */
const STORED = '/api/v1/files/10/download?inline=1';

describe('反显路径：库里的 url 数组 → 表单值', () => {
  it('每一张都必须是「lew-ui 认得出来的图片地址」', () => {
    const items = toUploadItems([
      STORED,
      '/api/v1/files/9/download?inline=1',
      '/images/local.png',
    ]);
    expect(items).toHaveLength(3);
    for (const item of items) {
      expect(LEW_IMAGE_RE.test(item.url ?? '')).toBe(true);
      expect(item.status).toBe('complete');
    }
    // 本来就带扩展名的地址不该被动手脚
    expect(items[2]?.url).toBe('/images/local.png');
  });

  it('key 不重复（同一张图出现两次也不会撞）', () => {
    const items = toUploadItems([STORED, STORED]);
    expect(new Set(items.map((item) => item.key)).size).toBe(2);
  });
});

describe('上传路径：刚上传成功 → 回填项', () => {
  it('**回填的 url 也必须是图片地址**（漏这一步 = 新传的图显示成文件图标）', () => {
    const item = toUploadedItem('upload-1', STORED, 'IMG_0001.png');
    // 原始地址 lew-ui 判成「不是图片」—— 这正是当初的 bug
    expect(LEW_IMAGE_RE.test(STORED)).toBe(false);
    // 回填值必须通过
    expect(LEW_IMAGE_RE.test(item.url ?? '')).toBe(true);
    expect(item.status).toBe('complete');
    expect(item.percent).toBe(100);
    expect(item.name).toBe('IMG_0001.png');
  });

  it('回填项与反显项对同一张图给出同样的显示地址', () => {
    const uploaded = toUploadedItem('upload-1', STORED);
    const saved = toUploadItems([STORED])[0];
    expect(uploaded.url).toBe(saved?.url);
  });
});

describe('提交路径：表单值 → 接口 url 数组', () => {
  it('入库的是**干净地址**，不带显示标记', () => {
    const uploaded = toUploadedItem('upload-1', STORED);
    expect(toImageUrls([uploaded])).toEqual([STORED]);
  });

  it('半成品不入库：pending / fail / wrong_size 一律丢掉', () => {
    const urls = toImageUrls([
      toUploadedItem('ok', STORED),
      { key: 'p', status: 'pending', url: STORED },
      { key: 'f', status: 'fail', url: '' },
      { key: 'w', status: 'wrong_size', url: STORED },
    ]);
    expect(urls).toEqual([STORED]);
  });

  it('空值 / 空地址安全', () => {
    expect(toImageUrls(null)).toEqual([]);
    expect(toImageUrls([{ key: 'x', status: 'complete', url: '' }])).toEqual(
      [],
    );
  });

  it('往返不变量：显示态转一圈回到原值，且不会越滚越长', () => {
    const raw = [STORED, '/images/local.png'];
    const once = toImageUrls(toUploadItems(raw));
    expect(once).toEqual(raw);
    // 再走一轮也还是原值（不会变成 ...?__img=.png&__img=.png）
    expect(toImageUrls(toUploadItems(once))).toEqual(raw);
    expect(stripDisplayImageUrl(toUploadItems(once)[0]?.url ?? '')).toBe(
      STORED,
    );
  });
});

describe('单图字段（美甲师头像）', () => {
  it('取第一张成功上传的图，且是干净地址', () => {
    expect(toSingleImageUrl([toUploadedItem('a', STORED)])).toBe(STORED);
    // 多传了一张也只是「取第一张」，不会拼成数组（接口要的是 string | null）
    expect(
      toSingleImageUrl([
        toUploadedItem('a', STORED),
        toUploadedItem('b', '/api/v1/files/9/download?inline=1'),
      ]),
    ).toBe(STORED);
  });

  it('没有可用图片时是 null（而不是空字符串 / 空数组）', () => {
    expect(toSingleImageUrl([])).toBeNull();
    expect(toSingleImageUrl(null)).toBeNull();
    expect(
      toSingleImageUrl([{ key: 'p', status: 'pending', url: STORED }]),
    ).toBeNull();
    expect(
      toSingleImageUrl([{ key: 'f', status: 'fail', url: '' }]),
    ).toBeNull();
  });
});

describe('上传组件的 accept', () => {
  it('只列后端白名单里有的图片类型（手机相册的 heic/avif 会被后端拒）', () => {
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/svg+xml',
    ]) {
      expect(IMAGE_ACCEPT).toContain(type);
    }
    expect(IMAGE_ACCEPT).not.toContain('image/avif');
    expect(IMAGE_ACCEPT).not.toContain('image/heic');
    // 别再写 image/* 图省事：那会给出注定上传失败的文件
    expect(IMAGE_ACCEPT).not.toBe('image/*');
  });
});
