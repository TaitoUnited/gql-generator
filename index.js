#!/usr/bin/env node
/* eslint-disable no-shadow */
/* eslint-disable no-useless-escape */
/* eslint-disable prefer-destructuring */
/* eslint-disable no-use-before-define */
const fs = require('fs');
const path = require('path');
const program = require('commander');
const { Source, buildSchema } = require('graphql');
const del = require('del');

program
  .option('--schemaFilePath [value]', 'path of your graphql schema file')
  .option('--destDirPath [value]', 'dir you want to store the generated queries')
  .option('--depthLimit [value]', 'limit the max depth of the generated query')
  .parse(process.argv);

const schemaFilePath = program.schemaFilePath;
const destDirPath = program.destDirPath;

console.log('[gqlg]:', `Going to create 3 folders to store the queries inside path: ${destDirPath}`);
const typeDef = fs.readFileSync(schemaFilePath, 'utf8');

const source = new Source(typeDef);
// const ast = parse(source);
const gqlSchema = buildSchema(source);

const addQueryDepthLimit = program.depthLimit || 100;
// schema.getType

/**
 * Cleans out getType() names to contain only the type name itself
 * @param name
 */
function cleanName(name) {
  return name.replace(/[\[\]!]/g, '');
}

function getName(type) {
  if ('ofType' in type) {
    return getName(type.ofType);
  }

  return type.name;
}

function camelCase(parts) {
  return parts.reduce((str, cur) => `${str}${cur.slice(0, 1).toLocaleUpperCase()}${cur.slice(1).toLocaleLowerCase()}`);
}

/**
 * Generate the query for the specified field
 * @param name name of the current field
 * @param parentType parent type of the current field
 * @param parentFields preceding parent field and type combinations
 */
function generateQuery(name, parentType) {
  let query = '';
  const hasArgs = false;
  const argTypes = []; // [{name: 'id', type: 'Int!'}]

  const fieldData = generateFieldData(name, parentType, [], 1);

  const argStr =
    argTypes.length > 0 ? `(${argTypes.map((argType) => `${argType.name}: ${argType.type}`).join(', ')})` : '';

  // Add the root type of the query
  switch (parentType) {
    case gqlSchema.getQueryType() && gqlSchema.getQueryType().name:
      query += `query ${name}${argStr} `;
      break;
    case gqlSchema.getMutationType() && gqlSchema.getMutationType().name:
      query += `mutation ${name}${argStr} `;
      break;
    case gqlSchema.getSubscriptionType() && gqlSchema.getSubscriptionType().name:
      query += `subscription ${name}${argStr} `;
      break;
    default:
      throw new Error('parentType is not one of mutation/query/subscription');
  }

  // Add the query fields
  query += `{\n${fieldData.query}\n}`;

  const meta = { ...fieldData.meta };

  // Update hasArgs option
  meta.hasArgs = hasArgs || meta.hasArgs;

  return { query, meta };

  /**
   * Generate the query for the specified field
   * @param name name of the current field
   * @param parentType parent type of the current field
   * @param parentFields preceding parent field and type combinations
   * @param level current depth level of the current field
   */
  function generateFieldData(name, parentType, parentFields, level) {
    // console.log('Generating query for ', name, parentType);

    const tabSize = 4;
    const field = gqlSchema.getType(parentType).getFields()[name];

    const meta = {
      hasArgs: false,
      hasChildren: false,
    };

    // Start the query with the field name
    let fieldStr = ' '.repeat(level * tabSize) + field.name;

    // Retrieve the current field type
    const curTypeName = cleanName(getName(field.type));
    const curType = gqlSchema.getType(curTypeName);

    // Don't add a field if it has been added in the query already.
    // This happens when there is a recursive field
    if (parentFields.filter((x) => x.type === curTypeName).length) {
      return { query: '', meta: {} };
    }

    // If the field has arguments, add them
    if (field.args && field.args.length) {
      meta.hasArgs = true;

      const variableExists = (name) => argTypes.some((existing) => existing.name === `$${name}`);

      const args = field.args.map((arg) => {
        let varName = variableExists(arg.name)
          ? camelCase(parentFields.map((field) => field.name)
            .concat(name)
            .concat(arg.name)
          )
          : arg.name;

        if (variableExists(varName)) {
          const [number] = varName.match(/([0-9]+)$/) || [];
          if (!number) {
            varName = `${varName}1`;
          } else {
            varName = `${varName}${Number(number) + 1}`;
          }
        }

        return {
          type: arg.type,
          name: arg.name,
          varName,
        };
      });

      const argsList = args.reduce((acc, cur) => `${acc}, ${cur.name}: $${cur.varName}`, '').substring(2);

      fieldStr += `(${argsList})`;

      args.forEach((arg) => {
        argTypes.push({
          name: `$${arg.varName}`,
          type: arg.type,
        });
      });
    }

    // Get all the fields of the field type, if available
    const innerFields = curType.getFields && curType.getFields();
    let innerFieldsData = null;
    if (innerFields) {
      meta.hasChildren = true;
      innerFieldsData = Object.keys(innerFields)
        .reduce((acc, cur) => {
          // Don't add a field if it has been added in the query already.
          // This happens when there is a recursive field
          if (parentFields.filter((x) => x.name === cur && x.type === curTypeName).length) {
            return '';
          }

          const innerField = innerFields[cur];

          const innerTypeName = cleanName(getName(innerField.type));
          const innerType = gqlSchema.getType(innerTypeName);
          const subFields = innerType.getFields && innerType.getFields();
          const hasChildren = Object.keys(subFields || {}).length > 0;

          if (hasChildren && level + 1 >= addQueryDepthLimit) {
            return acc;
          }

          const curInnerFieldData = generateFieldData(
            cur,
            curTypeName,
            [...parentFields, { name, type: curTypeName }],
            level + 1
          );
          const curInnerFieldStr = curInnerFieldData.query;
          // Set the hasArgs meta if the inner field has args
          meta.hasArgs = meta.hasArgs || curInnerFieldData.meta.hasArgs;

          // Don't bother adding the field if there was nothing generated.
          // This should fix the empty line issue in the inserted queries
          if (!curInnerFieldStr) {
            return acc;
          }

          // Join all the fields together
          return `${acc}\n${curInnerFieldStr}`;
        }, '')
        .substring(1);
    }

    // Add the inner fields with braces if available
    if (innerFieldsData) {
      fieldStr += `{\n${innerFieldsData}\n`;
      fieldStr += `${' '.repeat(level * tabSize)}}`;
    }

    return { query: fieldStr, meta };
  }
}

const mutationsFolder = path.join(destDirPath, './mutations');
const queriesFolder = path.join(destDirPath, './queries');
const subscriptionsFolder = path.join(destDirPath, './subscriptions');

del.sync(mutationsFolder);
fs.mkdirSync(mutationsFolder);
del.sync(queriesFolder);
fs.mkdirSync(queriesFolder);
del.sync(subscriptionsFolder);
fs.mkdirSync(subscriptionsFolder);

const indexJsStart = `
const fs = require('fs');
const path = require('path');

`;

let indexJsExportAll = '';

if (gqlSchema.getMutationType()) {
  let mutationsIndexJs = indexJsStart;
  Object.keys(gqlSchema.getMutationType().getFields()).forEach((mutationType) => {
    const { query } = generateQuery(mutationType, 'Mutation');
    fs.writeFileSync(path.join(mutationsFolder, `./${mutationType}.gql`), query);
    mutationsIndexJs += `module.exports.${mutationType} = fs.readFileSync(path.join(__dirname, '${mutationType}.gql'), 'utf8');\n`;
  });
  fs.writeFileSync(path.join(mutationsFolder, 'index.js'), mutationsIndexJs);
  indexJsExportAll += `module.exports.mutations = require('./mutations');
`;
} else {
  console.log('[gqlg warning]:', 'No mutation type found in your schema');
}

if (gqlSchema.getQueryType()) {
  let queriesIndexJs = indexJsStart;
  Object.keys(gqlSchema.getQueryType().getFields()).forEach((queryType) => {
    const { query } = generateQuery(queryType, 'Query');
    fs.writeFileSync(path.join(queriesFolder, `./${queryType}.gql`), query);
    queriesIndexJs += `module.exports.${queryType} = fs.readFileSync(path.join(__dirname, '${queryType}.gql'), 'utf8');\n`;
  });
  fs.writeFileSync(path.join(queriesFolder, 'index.js'), queriesIndexJs);
  indexJsExportAll += "module.exports.queries = require('./queries');";
} else {
  console.log('[gqlg warning]:', 'No query type found in your schema');
}

if (gqlSchema.getSubscriptionType()) {
  let subscriptionsIndexJs = indexJsStart;
  Object.keys(gqlSchema.getSubscriptionType().getFields()).forEach((subscriptionType) => {
    const { query } = generateQuery(subscriptionType, 'Subscription');
    fs.writeFileSync(path.join(subscriptionsFolder, `./${subscriptionType}.gql`), query);
    subscriptionsIndexJs += `module.exports.${subscriptionType} = fs.readFileSync(path.join(__dirname, '${subscriptionType}.gql'), 'utf8');\n`;
  });
  fs.writeFileSync(path.join(subscriptionsFolder, 'index.js'), subscriptionsIndexJs);
  indexJsExportAll += "module.exports.subscriptions = require('./subscriptions');";
} else {
  console.log('[gqlg warning]:', 'No subscription type found in your schema');
}

fs.writeFileSync(path.join(destDirPath, 'index.js'), indexJsExportAll);
