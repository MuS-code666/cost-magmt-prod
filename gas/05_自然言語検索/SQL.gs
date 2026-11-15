// ============================================================
// SQL の組み立てと BigQuery の実行
//
// 組み立ての規則（nl_search/README.md「SQL の組み立て規則」）:
//   - 列名・ビュー名・集計式は NL_CATALOG（カタログ）の固定の文字列だけを書き込む
//   - 値（期間・工場名・製品名・顧客名）はすべてクエリパラメータで渡す
//   - 年月の絞り込みは必須。maximumBytesBilled で読み込み量に上限を掛ける
// nlBuildQuery_ は GAS のサービスを使わない（手元の run_local.js でも検証する）。
// ============================================================

// cond: nlValidateCondition_ / nlResolve_ で確定した条件。period: nlParsePeriod_ の結果
function nlBuildQuery_(cond, period) {
  const view = '`' + NL_CATALOG.view + '`';
  const monthCol = '`' + NL_CATALOG.period_column + '`';
  const metric = nlMetric_(cond.metric);
  const col = function(dim) { return '`' + nlDimension_(dim).column + '`'; };
  const dims = cond.group_by.map(col);
  const groupBySql = dims.length
    ? '\nGROUP BY ' + dims.map(function(_, i) { return i + 1; }).join(', ')
    : '';

  const params = [
    { name: 'start', type: 'DATE', value: period.start },
    { name: 'end', type: 'DATE', value: period.end }
  ];
  const filterSql = [];
  NL_FILTER_DIMS.forEach(function(dim) {
    const values = cond.filters.filter(function(f) { return f.dim === dim; }).map(function(f) { return f.value; });
    if (values.length === 0) return;
    filterSql.push(col(dim) + ' IN UNNEST(@f_' + dim + ')');
    params.push({ name: 'f_' + dim, type: 'ARRAY<STRING>', value: values });
  });
  const where = function(startParam, endParam) {
    return '\nWHERE ' + [monthCol + ' BETWEEN @' + startParam + ' AND @' + endParam].concat(filterSql).join('\n  AND ');
  };

  let orderSql = '';
  if (cond.order) {
    orderSql = '\nORDER BY ' + cond.order.by + ' ' + cond.order.dir.toUpperCase() + ' NULLS LAST';
  } else if (cond.group_by.indexOf('month') >= 0) {
    orderSql = '\nORDER BY ' + [monthCol].concat(dims.filter(function(d) { return d !== monthCol; })).join(', ');
  } else if (dims.length) {
    orderSql = '\nORDER BY value DESC NULLS LAST';
  }
  const limitSql = '\nLIMIT ' + (cond.limit || NL_CATALOG.limits.max_rows);

  if (!cond.compare) {
    return {
      sql: 'SELECT ' + dims.concat([metric.expr + ' AS value']).join(', ') +
        '\nFROM ' + view + where('start', 'end') + groupBySql + orderSql + limitSql,
      params: params,
      compare_period: null
    };
  }

  // 比較: 同じビューを比較先の期間で引き、切り口のキーで結合する。
  // 月の切り口は比較先の月をずらして、当期の月と同じキーにそろえる。
  const cmp = nlComparePeriod_(period, cond.compare);
  params.push({ name: 'cmp_start', type: 'DATE', value: cmp.start });
  params.push({ name: 'cmp_end', type: 'DATE', value: cmp.end });
  const cmpDims = cond.group_by.map(function(dim) {
    return dim === 'month'
      ? 'DATE_ADD(' + monthCol + ', INTERVAL ' + cmp.shift + ' MONTH) AS ' + monthCol
      : col(dim);
  });
  const sub = function(selectDims, startParam, endParam) {
    return 'SELECT ' + selectDims.concat([metric.expr + ' AS value']).join(', ') +
      '\n  FROM ' + view + where(startParam, endParam).replace(/\n/g, '\n  ') + groupBySql.replace(/\n/g, '\n  ');
  };
  return {
    sql: 'WITH cur AS (\n  ' + sub(dims, 'start', 'end') + '\n),\ncmp AS (\n  ' + sub(cmpDims, 'cmp_start', 'cmp_end') + '\n)' +
      '\nSELECT ' + dims.concat([
        'cur.value AS value',
        'cmp.value AS compare_value',
        'cur.value - cmp.value AS diff',
        'SAFE_DIVIDE(cur.value - cmp.value, ABS(cmp.value)) AS rate'
      ]).join(', ') +
      '\nFROM cur ' + (dims.length ? 'FULL OUTER JOIN cmp USING (' + dims.join(', ') + ')' : 'CROSS JOIN cmp') +
      orderSql + limitSql,
    params: params,
    compare_period: cmp
  };
}

// 画面の「SQLを見る」用。パラメータの値はコメントで添える
function nlSqlForDisplay_(q) {
  return q.sql + ';\n-- ' + q.params.map(function(p) {
    return '@' + p.name + ' = ' + (Array.isArray(p.value) ? '[' + p.value.join(', ') + ']' : p.value);
  }).join(' / ');
}

function nlQueryParameters_(params) {
  return params.map(function(p) {
    if (p.type === 'ARRAY<STRING>') {
      return {
        name: p.name,
        parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
        parameterValue: { arrayValues: p.value.map(function(v) { return { value: v }; }) }
      };
    }
    return { name: p.name, parameterType: { type: p.type }, parameterValue: { value: p.value } };
  });
}

// BigQuery を実行する。dryRun なら見積もりバイト数だけ返す
function nlRunQuery_(q, dryRun) {
  const c = NL_CONFIG;
  const request = {
    query: q.sql,
    useLegacySql: false,
    location: c.LOCATION,
    parameterMode: 'NAMED',
    queryParameters: nlQueryParameters_(q.params),
    maximumBytesBilled: String(NL_CATALOG.limits.maximum_bytes_billed),
    dryRun: !!dryRun
  };
  let result = BigQuery.Jobs.query(request, c.PROJECT_ID);
  if (dryRun) return { bytes: Number(result.totalBytesProcessed || 0) };

  const jobId = result.jobReference && result.jobReference.jobId;
  while (!result.jobComplete) {
    Utilities.sleep(500);
    result = BigQuery.Jobs.getQueryResults(c.PROJECT_ID, jobId, { location: c.LOCATION });
  }
  const names = result.schema.fields.map(function(f) { return f.name; });
  let apiRows = result.rows || [];
  while (result.pageToken) {
    result = BigQuery.Jobs.getQueryResults(c.PROJECT_ID, jobId, { location: c.LOCATION, pageToken: result.pageToken });
    apiRows = apiRows.concat(result.rows || []);
  }
  return {
    names: names,
    rows: apiRows.map(function(row) { return row.f.map(function(cell) { return cell.v; }); }),
    bytes: Number(result.totalBytesProcessed || 0)
  };
}

// 工場・製品・顧客の正式名称（辞書照合の照合先）。マスタ更新に追従するため v_cost から取り、6時間キャッシュする
function nlGetMasters_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(NL_CONFIG.MASTER_CACHE_KEY);
  if (hit) return JSON.parse(hit);

  const view = '`' + NL_CATALOG.view + '`';
  const sql = NL_FILTER_DIMS.map(function(dim) {
    const column = '`' + nlDimension_(dim).column + '`';
    return "SELECT '" + dim + "' AS dim, " + column + ' AS name FROM ' + view +
      ' WHERE ' + column + ' IS NOT NULL GROUP BY 2';
  }).join('\nUNION ALL\n') + '\nORDER BY 1, 2';

  const masters = { factory: [], product: [], customer: [] };
  nlRunQuery_({ sql: sql, params: [] }, false).rows.forEach(function(r) { masters[r[0]].push(r[1]); });
  cache.put(NL_CONFIG.MASTER_CACHE_KEY, JSON.stringify(masters), NL_CONFIG.MASTER_CACHE_SECONDS);
  return masters;
}
