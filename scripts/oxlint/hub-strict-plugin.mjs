function readMax(context, fallback) {
  const option = context.options[0];
  if (typeof option === "number") return option;
  return option?.max ?? fallback;
}

function promiseTypeArgument(typeNode) {
  const isPromise = typeNode.type === "TSTypeReference" && typeNode.typeName?.name === "Promise";
  if (!isPromise) return undefined;
  return (typeNode.typeArguments ?? typeNode.typeParameters)?.params[0];
}

function tupleLength(typeNode) {
  if (!typeNode) return 0;
  if (typeNode.type === "TSTupleType") return typeNode.elementTypes.length;
  return tupleLength(promiseTypeArgument(typeNode));
}

function constArrayLength(expression) {
  if (expression?.type !== "TSAsExpression") return 0;
  const annotation = expression.typeAnnotation;
  const isConst = annotation.type === "TSTypeReference" && annotation.typeName?.name === "const";
  if (!isConst || expression.expression.type !== "ArrayExpression") return 0;
  const elements = expression.expression.elements;
  return isTaggedKey(elements) ? 0 : elements.length;
}

// A leading string tag marks a cache or query key, which is one value, not several results.
function isTaggedKey(elements) {
  const first = elements[0];
  return first?.type === "Literal" && typeof first.value === "string";
}

const maxReturnValues = {
  meta: {
    type: "suggestion",
    docs: { description: "Limit tuple return values; return an object instead." },
    schema: [
      {
        anyOf: [{ type: "integer" }, { type: "object", properties: { max: { type: "integer" } } }],
      },
    ],
  },
  create(context) {
    const max = readMax(context, 3);
    const check = (node, count) => {
      if (count <= max) return;
      context.report({
        node,
        message: `Function returns ${count} values. Maximum allowed is ${max}; return an object instead.`,
      });
    };
    const checkSignature = (node) =>
      check(node.returnType ?? node, tupleLength(node.returnType?.typeAnnotation));
    return {
      FunctionDeclaration: checkSignature,
      FunctionExpression: checkSignature,
      TSDeclareFunction: checkSignature,
      TSMethodSignature: checkSignature,
      TSFunctionType: checkSignature,
      ArrowFunctionExpression(node) {
        checkSignature(node);
        if (node.expression) check(node.body, constArrayLength(node.body));
      },
      ReturnStatement(node) {
        check(node.argument ?? node, constArrayLength(node.argument));
      },
    };
  },
};

export default {
  meta: { name: "hub-strict" },
  rules: { "max-return-values": maxReturnValues },
};
