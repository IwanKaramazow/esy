/**
 * @flow
 */

import * as path from 'path';
import * as fs from 'fs';
import {sync as mkdirp} from 'mkdirp';
import outdent from 'outdent';

import * as BuildRepr from '../../build-repr';
import * as Env from '../../environment';
import * as Config from '../../config';
import * as Makefile from '../../Makefile';
import {flattenArray} from '../../util';

const RUNTIME = fs.readFileSync(path.join(__dirname, 'runtime.sh'), 'utf8');

const STORE_PATH = '$ESY_EJECT__STORE';
const SANDBOX_PATH = '$ESY_EJECT__SANDBOX';

/**
 * Note that Makefile based builds defers exact locations of sandbox and store
 * to some later point because ejected builds can be transfered to other
 * machines.
 *
 * That means that build env is generated in a way which can be configured later
 * with `$ESY_EJECT__SANDBOX` and `$ESY__STORE` environment variables.
 */
export const buildConfig: BuildRepr.BuildConfig = Config.createConfig({
  storePath: STORE_PATH,
  sandboxPath: SANDBOX_PATH,
});

/**
 * Render `build` as Makefile (+ related files) into the supplied `outputPath`.
 */
export function renderToMakefile(sandbox: BuildRepr.BuildSandbox, outputPath: string) {
  const ruleSet: Makefile.MakeItem[] = [
    {
      type: 'raw',
      value: 'SHELL := env -i /bin/bash --norc --noprofile',
    },

    // ESY_EJECT__ROOT is the root directory of the ejected Esy build
    // environment.
    {
      type: 'raw',
      value: 'ESY_EJECT__ROOT := $(dir $(realpath $(lastword $(MAKEFILE_LIST))))',
    },

    // ESY_EJECT__STORE is the directory where build artifacts should be stored.
    {
      type: 'raw',
      value: 'ESY_EJECT__STORE ?= $(HOME)/.esy',
    },

    // ESY_EJECT__SANDBOX is the sandbox directory, the directory where the root
    // package resides.
    {
      type: 'raw',
      value: 'ESY_EJECT__SANDBOX ?= $(CURDIR)',
    },

    // These are public API

    {
      type: 'rule',
      target: 'build',
      phony: true,
      dependencies: [createBuildRuleName(sandbox.root, 'build')],
    },
    {
      type: 'rule',
      target: 'build-shell',
      phony: true,
      dependencies: [createBuildRuleName(sandbox.root, 'shell')],
    },
    {
      type: 'rule',
      target: 'clean',
      phony: true,
      command: 'rm -rf $(ESY_EJECT__SANDBOX)/_build $(ESY_EJECT__SANDBOX)/_install $(ESY_EJECT__SANDBOX)/_insttmp',
    },

    // Create store directory structure
    {
      type: 'rule',
      target: '$(ESY_EJECT__STORE)/_install $(ESY_EJECT__STORE)/_build $(ESY_EJECT__STORE)/_insttmp',
      command: 'mkdir -p $(@)',
    },
    {
      type: 'rule',
      target: 'esy-store',
      phony: true,
      dependencies: [
        '$(ESY_EJECT__STORE)/_install',
        '$(ESY_EJECT__STORE)/_build',
        '$(ESY_EJECT__STORE)/_insttmp',
      ],
    },
    {
      type: 'rule',
      target: '$(ESY_EJECT__ROOT)/bin/realpath',
      dependencies: ['$(ESY_EJECT__ROOT)/bin/realpath.c'],
      shell: '/bin/bash',
      command: 'gcc -o $(@) -x c $(<) 2> /dev/null',
    },
    {
      type: 'rule',
      target: 'esy-root',
      phony: true,
      dependencies: ['$(ESY_EJECT__ROOT)/bin/realpath'],
    },
  ];

  function createBuildRuleName(build, target): string {
    return `${build.name}.${target}`;
  }

  function createBuildRule(
    build: BuildRepr.Build,
    rule: {target: string, command: string, withBuildEnv?: boolean},
  ): Makefile.MakeItem {
    const command = [];
    if (rule.withBuildEnv) {
      command.push(
        outdent`
          $(shell_env_for__${build.id}) source $(ESY_EJECT__ROOT)/bin/runtime.sh
          cd $esy_build__source_root
        `,
      );
    }
    command.push(rule.command);
    return {
      type: 'rule',
      target: createBuildRuleName(build, rule.target),
      dependencies: [
        'esy-store',
        'esy-root',
        ...build.dependencies.map(dep => createBuildRuleName(dep, 'build')),
      ],
      phony: true,
      command,
    };
  }

  function visitBuild(build: BuildRepr.Build) {
    // TODO: should be  path.join(outputPath, build.sourcePath)
    const packagePath = path.relative(outputPath, build.name).split(path.sep);

    function emitBuildFile({filename, contents}) {
      emitFile(outputPath, {filename: packagePath.concat(filename), contents});
    }

    // Emit env
    emitBuildFile({
      filename: 'env',
      contents: renderEnv(Env.calculateEnvironment(buildConfig, build, sandbox.env)),
    });

    // Emit findlib.conf.in
    const allDependencies = BuildRepr.collectTransitiveDependencies(build);
    const findLibDestination = buildConfig.getInstallPath(build, 'lib');
    // Note that some packages can query themselves via ocamlfind during its
    // own build, this is why we include `findLibDestination` in the path too.
    const findLibPath = allDependencies
      .map(dep => buildConfig.getFinalInstallPath(dep, 'lib'))
      .concat(findLibDestination)
      .join(':');

    emitBuildFile({
      filename: 'findlib.conf.in',
      contents: outdent`
        path = "${findLibPath}"
        destdir = "${findLibDestination}"
        ldconf = "ignore"
        ocamlc = "ocamlc.opt"
        ocamldep = "ocamldep.opt"
        ocamldoc = "ocamldoc.opt"
        ocamllex = "ocamllex.opt"
        ocamlopt = "ocamlopt.opt"
      `,
    });

    // Generate macOS sandbox configuration (sandbox-exec command)
    // TODO: Right now the only thing this sandbox configuration does is it
    // disallows writing into locations other than $cur__root,
    // $cur__target_dir and $cur__install. We should implement proper out of
    // source builds and also disallow $cur__root.
    // TODO: Try to use (deny default) and pick a set of rules for builds to
    // proceed (it chokes on xcodebuild for now if we disable reading "/" and
    // networking).
    emitBuildFile({
      filename: 'sandbox.sb.in',
      contents: outdent`
        (version 1.0)
        (allow default)

        (deny file-write*
          (subpath "/"))

        (allow file-write*
          (literal "/dev/null")

          (subpath "$TMPDIR_GLOBAL")
          (subpath "$TMPDIR")

          ; cur__root
          ; We don't really need to write into cur__root but some build systems
          ; can put .merlin files there so we allow that.
          (subpath "${buildConfig.getRootPath(build)}")

          ; cur__target_dir
          (subpath "${buildConfig.getBuildPath(build)}")

          ; cur__install
          (subpath "${buildConfig.getInstallPath(build)}")
        )

        (deny file-write*
          (subpath "${buildConfig.getRootPath(build, 'node_modules')}")
        )
      `,
    });

    ruleSet.push({
      type: 'define',
      name: `shell_env_for__${build.id}`,
      value: [
        {
          CI: process.env.CI ? process.env.CI : null,
          TMPDIR: '$(TMPDIR)',
          ESY_EJECT__STORE: '$(ESY_EJECT__STORE)',
          ESY_EJECT__SANDBOX: '$(ESY_EJECT__SANDBOX)',
          ESY_EJECT__ROOT: '$(ESY_EJECT__ROOT)',
        },
        `source $(ESY_EJECT__ROOT)/${packagePath.join('/')}/env`,
        {
          esy_build__eject: `$(ESY_EJECT__ROOT)/${packagePath.join('/')}`,
          esy_build__type: build.isMutable ? 'in-source' : 'out-of-source',
          esy_build__key: build.id,
          esy_build__command: renderBuildCommand(build) || 'true',
          esy_build__source_root: build.sourcePath,
          esy_build__install: buildConfig.getFinalInstallPath(build),
        },
      ],
    });

    ruleSet.push(
      createBuildRule(build, {
        target: 'build',
        command: 'esy-build',
        withBuildEnv: true,
      }),
    );
    ruleSet.push(
      createBuildRule(build, {
        target: 'shell',
        command: 'esy-shell',
        withBuildEnv: true,
      }),
    );
    ruleSet.push(
      createBuildRule(build, {
        target: 'clean',
        command: 'esy-clean',
      }),
    );
  }

  visitBuild(sandbox.root);

  // Now emit all build-wise artefacts

  emitFile(outputPath, {
    filename: ['bin/replace-string'],
    executable: true,
    contents: outdent`
      #!/usr/bin/env python2

      import sys
      import os
      import stat

      filename, src, dest = sys.argv[1:4]
      filename_stage = filename + '.esy_rewrite'

      filestat = os.stat(filename)

      # TODO: we probably should handle symlinks too in a special way,
      # to modify their location to a rewritten path

      with open(filename, 'r') as input_file:
        data = input_file.read()

      data = data.replace(src, dest)

      with open(filename_stage, 'w') as output_file:
        output_file.write(data)

      os.rename(filename_stage, filename)
      os.chmod(filename, stat.S_IMODE(filestat.st_mode))
    `,
  });

  emitFile(outputPath, {
    filename: ['bin/render-env'],
    executable: true,
    contents: outdent`
      #!/bin/bash

      set -e
      set -o pipefail

      _TMPDIR_GLOBAL=$($ESY__ROOT/bin/realpath "/tmp")

      if [ -d "$TMPDIR" ]; then
        _TMPDIR=$($ESY__ROOT/bin/realpath "$TMPDIR")
      else
        _TMPDIR="/does/not/exist"
      fi

      sed \\
        -e "s|\\$ESY__STORE|$ESY__STORE|g"          \\
        -e "s|\\$ESY__SANDBOX|$ESY__SANDBOX|g"      \\
        -e "s|\\$TMPDIR_GLOBAL|$_TMPDIR_GLOBAL|g"   \\
        -e "s|\\$TMPDIR|$_TMPDIR|g"                 \\
        $1 > $2
    `,
  });

  emitFile(outputPath, {
    filename: ['bin', 'realpath.c'],
    contents: outdent`
      #include<stdlib.h>

      main(int cc, char**vargs) {
        puts(realpath(vargs[1], 0));
        exit(0);
      }
    `,
  });

  emitFile(outputPath, {
    filename: ['bin', 'runtime.sh'],
    contents: RUNTIME,
  });

  emitFile(outputPath, {
    filename: ['Makefile'],
    contents: Makefile.renderMakefile(ruleSet),
  });
}

function emitFile(
  outputPath: string,
  file: {filename: Array<string>, contents: string, executable?: boolean},
) {
  const filename = path.join(outputPath, ...file.filename);
  mkdirp(path.dirname(filename));
  fs.writeFileSync(filename, file.contents);
  if (file.executable) {
    // fs.constants only became supported in node 6.7 or so.
    const mode = fs.constants && fs.constants.S_IRWXU ? fs.constants.S_IRWXU : 448;
    fs.chmodSync(filename, mode);
  }
}

function renderEnv(groups: Env.Environment): string {
  const env = flattenArray(groups.map(group => group.envVars));
  return env
    .filter(env => env.value != null)
    // $FlowFixMe: make sure env.value is refined above
    .map(env => `export ${env.name}="${env.value}";`)
    .join('\n');
}

function renderBuildCommand(build: BuildRepr.Build): ?string {
  if (build.command == null) {
    return null;
  }
  return build.command.join(' && ');
}
