/// <reference path="../visit.ts" />
/// <reference path="../util.ts" />
/// <reference path="../compile/compile.ts" />
/// <reference path="emitutil.ts" />
/// <reference path="emitter.ts" />
/// <reference path="gl.ts" />

module Backends.GL.GLSL {

import Type = Types.Type;
import TypeCheck = Types.Check.TypeCheck;
import TypeEnv = Types.Check.TypeEnv;

// Type checking for uniforms, which are automatically demoted from arrays to
// individual values when they persist.

// The type mixin itself.
export function type_mixin(fsuper: TypeCheck): TypeCheck {
  let type_rules = complete_visit(fsuper, {
    // The goal here is to take lookups into prior stages of type `X Array`
    // and turn them into type `X`.
    visit_lookup(tree: LookupNode, env: TypeEnv): [Type, TypeEnv] {
      // Look up the type and stage of a variable.
      if (env.anns[0] === "s") {  // Shader stage.
        let [t, pos] = stack_lookup(env.stack, tree.ident);
        if (t !== undefined && pos > 0) {
          return [_unwrap_array(t), env];
        }
      }

      return fsuper(tree, env);
    },

    // Do the same for ordinary persist-escapes.
    // This is one downside of our desugaring: we have two cases here instead
    // of just one (cross-stage variable references). We need this even to
    // type-elaborate the subtrees generated by desugaring.
    visit_escape(tree: EscapeNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = fsuper(tree, env);
      if (env.anns[0] === "s") {  // Shader stage.
        if (tree.kind === "persist") {
          return [_unwrap_array(t), e];
        }
      }
      return [t, e];
    },
  });

  return function (tree: SyntaxNode, env: TypeEnv): [Type, TypeEnv] {
    return ast_visit(type_rules, tree, env);
  };
};


// The core compiler rules for emitting GLSL code.

function emit_extern(name: string, type: Type): string {
  return name;
}

function emit_decl(qualifier: string, type: string, name: string) {
  return qualifier + " " + type + " " + name + ";";
}

function emit_type(type: Type): string {
  if (type instanceof Types.PrimitiveType) {
    let name = TYPE_NAMES[type.name];
    if (name === undefined) {
      throw "error: primitive type " + type.name + " unsupported in GLSL";
    } else {
      return name;
    }
  } else {
    throw "error: type unsupported in GLSL: " + type;
  }
}

let compile_rules: ASTVisit<Emitter, string> = {
  visit_literal(tree: LiteralNode, emitter: Emitter): string {
    let [t,] = emitter.ir.type_table[tree.id];
    if (t === Types.INT) {
      return tree.value.toString();
    } else if (t === Types.FLOAT) {
      // Make sure that even whole numbers are emitting as floating-point
      // literals.
      let out = tree.value.toString();
      if (out.indexOf(".") === -1) {
        return out + ".0";
      } else {
        return out;
      }
    } else {
      throw "error: unknown literal type";
    }
  },

  visit_seq(tree: SeqNode, emitter: Emitter): string {
    return emit_seq(emitter, tree, ",\n");
  },

  visit_let(tree: LetNode, emitter: Emitter): string {
    let varname = shadervarsym(nearest_quote(emitter.ir, tree.id), tree.id);
    return varname + " = " + paren(emit(emitter, tree.expr));
  },

  visit_assign(tree: AssignNode, emitter: Emitter): string {
    // TODO Prevent assignment to nonlocal variables.
    let vs = (id:number) => shadervarsym(nearest_quote(emitter.ir, tree.id), id);
    return emit_assign(emitter, tree, vs);
  },

  visit_lookup(tree: LookupNode, emitter: Emitter): string {
    return emit_lookup(emitter, emit_extern, tree, function (id:number) {
      let [type,] = emitter.ir.type_table[id];
      if (_is_cpu_scope(emitter.ir, nearest_quote(emitter.ir, id)) && !_attribute_type(type)) {
        // References to variables defined on the CPU ("uniforms") get a
        // special naming convention so they can be shared between multiple
        // shaders in the same program.
        return varsym(id);
      } else {
        // Ordinary shader-scoped variable.
        return shadervarsym(nearest_quote(emitter.ir, tree.id), id);
      }
    });
  },

  visit_unary(tree: UnaryNode, emitter: Emitter): string {
    let p = emit(emitter, tree.expr);
    return tree.op + paren(p);
  },

  visit_binary(tree: BinaryNode, emitter: Emitter): string {
    return paren(emit(emitter, tree.lhs)) + " " +
           tree.op + " " +
           paren(emit(emitter, tree.rhs));
  },

  visit_quote(tree: QuoteNode, emitter: Emitter): string {
    throw "unimplemented";
  },

  visit_escape(tree: EscapeNode, emitter: Emitter): string {
    if (tree.kind === "splice") {
      return splicesym(tree.id);
    } else if (tree.kind === "persist") {
      return shadervarsym(nearest_quote(emitter.ir, tree.id), tree.id);
    } else if (tree.kind === "snippet") {
      return splicesym(tree.id);  // SNIPPET TODO
    } else {
      throw "error: unknown escape kind";
    }
  },

  visit_run(tree: RunNode, emitter: Emitter): string {
    throw "unimplemented";
  },

  visit_fun(tree: FunNode, emitter: Emitter): string {
    throw "unimplemented";
  },

  visit_call(tree: CallNode, emitter: Emitter): string {
    // The fragment call emits nothing here.
    if (frag_expr(tree)) {
      return "";
    }

    // Check that it's a static call.
    if (tree.fun.tag === "lookup") {
      let fun = emit(emitter, tree.fun);
      let args: string[] = [];
      for (let arg of tree.args) {
        args.push(emit(emitter, arg));
      }
      return fun + "(" + args.join(", ") + ")";
    }

    throw "error: GLSL backend is not higher-order";
  },

  visit_extern(tree: ExternNode, emitter: Emitter): string {
    let defid = emitter.ir.defuse[tree.id];
    let name = emitter.ir.externs[defid];
    return emit_extern(name, null);
  },

  visit_persist(tree: PersistNode, emitter: Emitter): string {
    throw "error: persist cannot appear in source";
  },

  visit_if(tree: IfNode, emitter: Emitter): string {
    return emit_if(emitter, tree);
  },
};

export function compile(tree: SyntaxNode, emitter: Emitter): string {
  return ast_visit(compile_rules, tree, emitter);
}


// Emitting the surrounding machinery for communicating between stages.

export function compile_prog(ir: CompilerIR,
  glue: Glue[][], progid: number): string
{
  let emitter: Emitter = {
    ir: ir,
    substitutions: [],
    compile: compile,
    emit_proc: null,
    emit_prog: null,
  };

  // TODO compile the functions

  let prog = ir.progs[progid];

  // Check whether this is a vertex or fragment shader.
  let kind = prog_kind(ir, progid);
  if (kind !== ProgKind.vertex && kind !== ProgKind.fragment) {
    throw "error: unexpected program kind";
  }

  // Declare `in` variables for the persists and free variables.
  let decls: string[] = [];
  for (let g of glue[progid]) {
    let qual: string;
    if (g.attribute) {
      qual = "attribute";
    } else if (g.from_host) {
      qual = "uniform";
    } else {
      qual = "varying";
    }
    decls.push(emit_decl(qual, emit_type(g.type), g.name));
  }

  // Declare `out` variables for the persists (and free variables) in the
  // subprogram. At the same time, accumulate the assignment statements that
  // we'll use to set these `out` variables.
  let varying_asgts: string[] = [];
  // There can be at most one subprogram for every shader.
  if (prog.quote_children.length > 1) {
    throw "error: too many subprograms";
  } else if (prog.quote_children.length === 1) {
    let subprog = ir.progs[prog.quote_children[0]];
    for (let g of glue[subprog.id]) {
      if (!g.from_host) {
        decls.push(emit_decl("varying", emit_type(g.type), g.name));

        let value: string;
        if (g.value_name) {
          value = g.value_name;
        } else {
          value = paren(emit(emitter, g.value_expr));
        }
        varying_asgts.push(`${g.name} = ${value}`);
      }
    }
  }

  // Emit the bound variable declarations.
  let local_decls: string[] = [];
  for (let id of prog.bound) {
    let [t,] = ir.type_table[id];
    local_decls.push(`${emit_type(t)} ${shadervarsym(progid, id)};\n`);
  }
  let local_decls_s = local_decls.join("");

  // Wrap the code in a "main" function.
  let code = emit_body(emitter, prog.body, "");
  code = local_decls_s + code;
  if (varying_asgts.length) {
    code += "\n// pass to next stage\n" + varying_asgts.join(";\n") + ";";
  }
  let main = `void main() {\n${indent(code, true)}\n}`;

  // This version of GLSL requires a precision declaration.
  let out = "precision mediump float;\n";

  // Concatenate the declarations and the main function.
  if (decls.length) {
    out += decls.join("\n") + "\n";
  }
  out += main;
  return out;
}

}
