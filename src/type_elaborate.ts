/// <reference path="type.ts" />
/// <reference path="type_check.ts" />
/// <reference path="util.ts" />

// A container for elaborated type information.
type TypeTable = [Type, TypeEnv][];

// A functional mixin for the type checker that stores the results in a table
// on the side. The AST must be stamped with IDs.
function elaborate_mixin(type_table : TypeTable): Gen<TypeCheck> {
  return function(fsuper: TypeCheck): TypeCheck {
    return function(tree: SyntaxNode, env: TypeEnv): [Type, TypeEnv] {
      let [t, e] = fsuper(tree, env);
      type_table[tree.id] = [t, e];
      return [t, e];
    };
  };
}

// Deep copy an object structure and add IDs to every object.
function stamp <T> (o: T, start: number = 0): T & { id: number } {
  let id = start;

  function helper (o: any): any {
    if (o instanceof Array) {
      let out: any[] = [];
      for (let el of o) {
        out.push(helper(el));
      }
      return out;

    } else if (o instanceof Object) {
      let copy = merge(o);
      copy.id = id;
      ++id;

      for (let key in copy) {
        if (copy.hasOwnProperty(key)) {
          copy[key] = helper(copy[key]);
        }
      }

      return copy;
    } else {
      return o;
    }
  };

  return helper(o);
}

// Get a recursive check-and-elaborate function. By default, this uses the
// ordinary `gen_check` rules, but clients can compose it with their own type
// for custom behavior.
function get_elaborate(type_table: TypeTable, f: Gen<TypeCheck> = gen_check) {
  return fix(compose(elaborate_mixin(type_table), f));
}

// A helper for elaboration that works on subtrees. You can start with an
// initial environment and a type table for other nodes; this will assign
// fresh IDs to the subtree and *append* to the type table.
function elaborate_subtree(tree: SyntaxNode, initial_env: TypeEnv,
  type_table: TypeTable, check: Gen<TypeCheck> = gen_check): SyntaxNode
{
  let stamped_tree = stamp(tree, type_table.length);
  let _elaborate = get_elaborate(type_table, check);
  _elaborate(stamped_tree, initial_env);
  return stamped_tree;
}

// Type elaboration. Create a copy of the AST with ID stamps and a table that
// maps the IDs to type information. You can optionally provide:
// - An initial type mapping for externs (for implementing intrinsics).
// - The set of named types.
function elaborate(tree: SyntaxNode, externs: TypeMap = BUILTIN_TYPES,
  named_types: TypeMap = BUILTIN_TYPES, check: Gen<TypeCheck> = gen_check):
  [SyntaxNode, TypeTable]
{
  let table : TypeTable = [];
  let env: TypeEnv = [[{}], externs, named_types];
  let elaborated = elaborate_subtree(tree, env, table, check);
  return [elaborated, table];
}
