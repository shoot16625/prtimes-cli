/** Master data shaped like GET .../press_release/editor and GET .../purposes responses. */
export const RAW_EDITOR = {
  release_types: [{ release_type_id: "01", release_type_name: "商品サービス" }],
  business_categories: [
    { busi_cate_id: "002", busi_cate_name: "企業向けシステム・通信・機器", lv2: [{ id: 9, name: "システム・Webサイト・アプリ開発" }] },
    { busi_cate_id: "003", busi_cate_name: "流通", lv2: [{ id: 11, name: "EC・通販" }] },
    { busi_cate_id: "099", busi_cate_name: "その他", lv2: [{ id: 99, name: "EC・通販" }] },
  ],
};
export const RAW_PURPOSES = [{ category_name: "マーケティング／PR", purpose_list: [{ purpose_id: 1, purpose_name: "新サービス開始" }] }];
