export const COMMON_FIELDS = ["单据日期", "单据编号", "创建时间", "业务员名字", "业务员编码", "合同号", "供应商", "厂家", "单据类型", "唛头", "工厂发货日期", "收货准时度", "备注"];
export const ITEM_FIELDS = ["存货编码", "存货", "中文名称", "中包规格", "数量", "单位", "采购单位", "单价", "金额", "总体积", "件数", "品牌1", "客户货号", "产品分类", "工厂中文品名", "产品备注"];

export const SAMPLE_FIELDS = [...COMMON_FIELDS, ...ITEM_FIELDS];

export const DEFAULT_LAYOUT = [
  { mapping: "单据日期", x: 570, y: 110, width: 100, height: 35 },
  { mapping: "合同号", x: 120, y: 110, width: 120, height: 35 },
  { mapping: "业务员名字", x: 120, y: 155, width: 80, height: 35 },
  { mapping: "存货编码", x: 35, y: 275, width: 100, height: 35 },
  { mapping: "中文名称", x: 150, y: 275, width: 200, height: 35 },
  { mapping: "数量", x: 480, y: 275, width: 50, height: 35 },
  { mapping: "单价", x: 535, y: 275, width: 50, height: 35 },
  { mapping: "金额", x: 635, y: 275, width: 65, height: 35 },
  { mapping: "总体积", x: 800, y: 275, width: 65, height: 35 }
];

export const LAYOUT_STORAGE_KEY = 'solo:flow_layout';
export const DEFAULT_ROW_HEIGHT = 35;
