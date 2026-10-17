/**
 * 工具定义的小工具：把「属性级 required: true」的写法转成标准 JSON Schema。
 *
 * DSH 官方的工具都用 `defineTool()` 造，它会把属性上的 `required: true`
 * 提成对象级的 `required: [...]` 数组。本插件不硬依赖 `@deepseek-ai/dsh-tools`
 * （那是宿主内部包，版本一变就可能对不上），因此在这里做同一件事。
 *
 * 转换规则只有两条：
 *   - 一个对象里，凡标了 `required: true` 的属性，名字进 `required` 数组；
 *   - 属性自己的 `required` 标记去掉（它不是合法 JSON Schema 关键字）。
 *
 * `parameters` 与 `output.schema` 都走这一套。
 */

/** 属性级 required 标记。 */
const REQUIRED = 'required';

/**
 * 把一棵 schema 树里的属性级 `required: true` 提成对象级 `required` 数组。
 * 原位不改，返回新对象。
 */
export function normalizeSchema(node) {
  if (Array.isArray(node)) return node.map(normalizeSchema);
  if (!node || typeof node !== 'object') return node;

  const out = {};
  /** 本层被标成 required 的属性名。 */
  const requiredNames = [];

  for (const [key, value] of Object.entries(node)) {
    // 对象级 required 已经是数组，原样保留
    if (key === REQUIRED && Array.isArray(value)) {
      out.required = value.map(String);
      continue;
    }
    if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const clean = { ...propSchema };
        if (clean[REQUIRED] === true) {
          requiredNames.push(propName);
          delete clean[REQUIRED];
        }
        props[propName] = normalizeSchema(clean);
      }
      out.properties = props;
      continue;
    }
    if (key === 'items' || key === 'additionalProperties') {
      out[key] = normalizeSchema(value);
      continue;
    }
    if (Array.isArray(value) && (key === 'oneOf' || key === 'anyOf' || key === 'allOf')) {
      out[key] = value.map(normalizeSchema);
      continue;
    }
    out[key] = value;
  }

  // 属性上声明的必填项合成对象级数组；已经写好的对象级 required 取并集
  if (requiredNames.length) {
    const existing = Array.isArray(out.required) ? out.required : [];
    out.required = [...new Set([...existing, ...requiredNames])];
  }
  return out;
}

/**
 * 造一个工具定义。
 *
 * `parameters` 用属性级 `required: true` 的写法，这里自动转成标准 schema；
 * `output.schema` 也一样。
 */
export function defineTool(options) {
  const { name, description, parameters, output, execute } = options;
  if (!name) throw new Error('defineTool: name is required');
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute must be a function`);
  if (!output || !output.schema) throw new Error(`defineTool(${name}): output.schema is required`);
  if (typeof output.render !== 'function') throw new Error(`defineTool(${name}): output.render is required`);

  // parameters 是一个隐式的对象根：属性表直接展开在顶层
  const parameterSchema = normalizeSchema({
    type: 'object',
    additionalProperties: false,
    properties: parameters ?? {},
  });

  return {
    name,
    description: String(description ?? ''),
    parameters: parameterSchema,
    output: {
      schema: normalizeSchema(output.schema),
      render: output.render,
    },
    execute,
  };
}
