const path = require('path');
const glob = require('glob');
const chalk = require('chalk');
const fs = require('fs-extra');
const prompts = require('prompts');
const ErrorMessage = require('./error-message');

const packageNameRegex = /.+\/(elm-)?review-.+/;

async function create(options) {
  const elmJson = readElmJson(options);

  if (!elmJson) {
    /* eslint-disable prettier/prettier */
    throw new ErrorMessage.CustomError("COULD NOT FIND ELM.JSON",
    `I could not find a ${chalk.yellow('elm.json')} file. I need you to be inside an Elm project.

You can run ${chalk.cyan('elm-review new-package')} to get started with a new project designed to publish review rules.`)
    /* eslint-enable prettier/prettier */
  }

  if (options.newRuleName) {
    validateRuleName(options.newRuleName);
  }

  const ruleName = options.newRuleName || (await askForRuleName());

  if (ruleName) {
    await addRule(options, elmJson, ruleName);
  }
}

function readElmJson(options) {
  if (!options.elmJsonPath) {
    return null;
  }

  try {
    return fs.readJsonSync(options.elmJsonPath, 'utf8');
  } catch {
    return null;
  }
}

const ruleNameRegex = /^[A-Z]\w*(\.[A-Z]\w*)*$/;

function validateRuleName(ruleName) {
  if (!ruleNameRegex.test(ruleName)) {
    throw new ErrorMessage.CustomError(
      'INVALID RULE NAME',
      'The rule name needs to be a valid Elm module name that only contains characters A-Z, digits and `_`.'
    );
  }
}

async function askForRuleName() {
  let canceled = false;
  const {ruleName} = await prompts(
    {
      type: 'text',
      name: 'ruleName',
      message: `Name of the rule (ex: No.Doing.Foo):`
    },
    {
      onCancel: () => {
        canceled = true;
        return false;
      }
    }
  );

  if (canceled) {
    return null;
  }

  if (!ruleNameRegex.test(ruleName)) {
    console.log(
      'The rule name needs to be a valid Elm module name that only contains characters A-Z, digits and `_`.'
    );
    return askForRuleName();
  }

  return ruleName;
}

function writeFile(dir, fileName, content) {
  fs.writeFileSync(path.join(dir, fileName), content);
}

async function addRule(options, elmJson, ruleName) {
  const ruleNameFolder = ruleName.split('.').slice(0, -1).join('/');
  const dir = path.dirname(options.elmJsonPath);

  try {
    fs.mkdirpSync(path.join(dir, 'src', ruleNameFolder));
  } catch {}

  try {
    fs.mkdirpSync(path.join(dir, 'tests', ruleNameFolder));
  } catch {}

  console.log(`Adding rule - ${ruleName}`);

  writeFile(
    dir,
    path.join('src', `${ruleName.split('.').join('/')}.elm`),
    newSourceFile(elmJson.name, ruleName)
  );
  writeFile(
    dir,
    path.join('tests', `${ruleName.split('.').join('/')}Test.elm`),
    newTestFile(ruleName)
  );

  if (elmJson.type === 'package' && packageNameRegex.test(elmJson.name)) {
    console.log('Exposing the rule in elm.json');
    if (!elmJson['exposed-modules'].includes(ruleName)) {
      const newElmJson = {
        ...elmJson,
        'exposed-modules': [...elmJson['exposed-modules'], ruleName].sort()
      };

      writeFile(dir, 'elm.json', JSON.stringify(newElmJson, null, 4));

      console.log('Adding rule to the README');
    }

    try {
      const readmeContent = fs.readFileSync(
        path.join(dir, 'README.md'),
        'utf8'
      );
      injectRuleInReadme(dir, elmJson, ruleName, readmeContent);
    } catch {
      console.log(
        `${chalk.red('[WARNING]')} Could not find a ${chalk.yellow(
          'README.md'
        )}`
      );
    }
  }

  // Inject configuration into every preview configuration
  glob
    .sync(makePathOsAgnostic(`${dir}/preview*/**/elm.json`), {
      nocase: true,
      ignore: ['**/elm-stuff/**'],
      nodir: false
    })
    .forEach((configurationElmJson) => {
      injectRuleInPreview(
        path.dirname(configurationElmJson),
        elmJson,
        ruleName
      );
    });
}

function makePathOsAgnostic(path_) {
  return path_.replace(/.:/, '').replace(/\\/g, '/');
}

function injectRuleInPreview(dir, elmJson, ruleName) {
  try {
    const content = fs.readFileSync(
      path.join(dir, 'src/ReviewConfig.elm'),
      'utf8'
    );
    const lines = content.split('\n');
    insertRuleInConfiguration(dir, elmJson, ruleName, lines);
    writeFile(dir, 'src/ReviewConfig.elm', lines.join('\n'));
  } catch {
    console.log(
      `${chalk.red('[WARNING]')} Could not find ${chalk.yellow(
        path.join(dir, 'src/ReviewConfig.elm')
      )}`
    );
  }
}

function injectRuleInReadme(dir, elmJson, ruleName, content) {
  const lines = content.split('\n');
  insertRuleDescription(elmJson, ruleName, lines);
  insertRuleInConfiguration(dir, elmJson, ruleName, lines);
  writeFile(dir, 'README.md', lines.join('\n'));
}

const ruleSectionRegex = /^#+.*rules/i;

// Mutates `lines`!
function insertRuleDescription(elmJson, ruleName, lines) {
  const rulesSectionIndex = lines.findIndex((line) =>
    ruleSectionRegex.test(line)
  );

  if (rulesSectionIndex) {
    if (!alreadyHasRuleDescription(ruleName, rulesSectionIndex, lines)) {
      const description = ruleDescription(
        elmJson.name,
        elmJson.version,
        ruleName
      );
      lines.splice(rulesSectionIndex + 2, 0, description);
    }
  } else {
    console.log(
      `${chalk.red('[WARNING]')} Could not find a ${chalk.yellow(
        'Provided rules'
      )} section in README to include the rule in`
    );
  }
}

function alreadyHasRuleDescription(ruleName, rulesSectionIndex, lines) {
  const nextSectionIndex = findNextSectionIndex(rulesSectionIndex, lines);

  const textBlock = lines.slice(rulesSectionIndex, nextSectionIndex).join('\n');

  return textBlock.includes(
    `- [\`${ruleName}\`](https://package.elm-lang.org/packages`
  );
}

function findNextSectionIndex(previousSectionIndex, lines) {
  const nextSectionIndex = lines
    .slice(previousSectionIndex + 1)
    .findIndex((line) => /^#+/.test(line));

  if (nextSectionIndex === -1) {
    return lines.length;
  }

  return previousSectionIndex + nextSectionIndex + 1;
}

// Mutates `lines`!
function insertRuleInConfiguration(
  configurationPath,
  elmJson,
  ruleName,
  lines
) {
  if (lines.join('\n').includes(`import ${ruleName}\n`)) {
    // Rule already exists in configuration
    return;
  }

  const someOtherRule = elmJson['exposed-modules'][0];
  insertImport(configurationPath, ruleName, lines);
  insertRuleInConfigList(ruleName, someOtherRule, lines);
}

function insertImport(configurationPath, ruleName, lines) {
  const firstImportIndex = lines.findIndex((line) => line.startsWith('import'));

  if (firstImportIndex === -1) {
    console.log(
      `${chalk.red(
        '[WARNING]'
      )} Could not find where to add an import of the rule in the ${configurationPath} configuration`
    );
    return;
  }

  let numberOfImports = 1;
  while (
    firstImportIndex + numberOfImports < lines.length &&
    lines[firstImportIndex + numberOfImports].startsWith('import')
  ) {
    numberOfImports++;
  }

  const importLines = [
    ...lines.slice(firstImportIndex, firstImportIndex + numberOfImports),
    `import ${ruleName}`
  ].sort();
  lines.splice(firstImportIndex, numberOfImports, ...importLines);
}

function insertRuleInConfigList(ruleName, someOtherRule, lines) {
  const indexOfOtherRuleExample = lines.findIndex((line) =>
    line.includes(`${someOtherRule}.rule`)
  );

  if (indexOfOtherRuleExample === -1) {
    console.log(
      `${chalk.red(
        '[WARNING]'
      )} Could not find an example configuration to include the rule in`
    );
    return;
  }

  const line = lines[indexOfOtherRuleExample];
  if (line.trim().startsWith('[')) {
    lines.splice(indexOfOtherRuleExample + 1, 0, `    , ${ruleName}.rule`);
  } else {
    lines.splice(indexOfOtherRuleExample, 0, `    , ${ruleName}.rule`);
  }
}

function newSourceFile(fullPackageName, ruleName) {
  return `module ${ruleName} exposing (rule)

{-|

@docs rule

-}

import Review.Rule as Rule exposing (Rule)


{-| Reports... REPLACEME

    config =
        [ ${ruleName}.rule
        ]


## Fail

    a =
        "REPLACEME example to replace"


## Success

    a =
        "REPLACEME example to replace"


## When (not) to enable this rule

This rule is useful when REPLACEME.
This rule is not useful when REPLACEME.


## Try it out

You can try this rule out by running the following command:

\`\`\`bash
elm-review --template ${fullPackageName}/example --rules ${ruleName}
\`\`\`

-}
rule : Rule
rule =
    Rule.newModuleRuleSchema "${ruleName}" ()
        -- Add your visitors
        |> Rule.fromModuleRuleSchema
`;
}

function newTestFile(ruleName) {
  return `module ${ruleName}Test exposing (all)

import ${ruleName} exposing (rule)
import Review.Test
import Test exposing (Test, describe, test)


all : Test
all =
    describe "${ruleName}"
        [ test "should report an error when REPLACEME" <|
            \\() ->
                """module A exposing (..)
a = 1
"""
                    |> Review.Test.run rule
                    |> Review.Test.expectErrors
                        [ Review.Test.error
                            { message = "REPLACEME"
                            , details = [ "REPLACEME" ]
                            , under = "REPLACEME"
                            }
                        ]
        ]
`;
}

function ruleDescription(packageName, packageVersion, ruleName) {
  const ruleNameAsUrl = ruleName.split('.').join('-');
  return `- [\`${ruleName}\`](https://package.elm-lang.org/packages/${packageName}/${packageVersion}/${ruleNameAsUrl}) - Reports REPLACEME.`;
}

module.exports = {
  create,
  askForRuleName,
  newSourceFile,
  newTestFile,
  ruleDescription,
  validateRuleName
};
