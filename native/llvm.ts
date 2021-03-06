import * as ast from '../src/ast';
import { ASTVisit, ast_visit, complete_visit } from '../src/visit';
import { INT, FLOAT, Type, OverloadedType, FunType, CodeType } from '../src/type';
import { Proc, Prog, Variant, Scope, CompilerIR } from '../src/compile/ir'
import * as llvm from 'llvmc';
import { varsym, persistsym, procsym, progsym, is_fun_type,
  useful_pred } from '../src/backends/emitutil';

/**
 * Export the LLVM Module type, which is the result of LLVM compilation.
 */
export type Module = llvm.Module;

///////////////////////////////////////////////////////////////////
// Begin Emit Functions & Redundant Funcs
///////////////////////////////////////////////////////////////////

/**
 * Like `emitter.Emitter`, but for generating LLVM code instead of strings.
 */
export interface LLVMEmitter {
  /**
   * LLVM Module object
   */
  mod: llvm.Module;

  /**
   * The LLVM IRBuilder object used to generate code.
   */
  builder: llvm.Builder;

  /**
   * Map from id's to Alloca ptr's
   */
  named_values: llvm.Value[];

  /**
   * Program we are compiling
   */
  ir: CompilerIR;

  // These are copies of `emitter.Emitter`'s `emit_` functions, except for
  // generating LLVM IR constructs.
  emit_expr: (tree: ast.SyntaxNode, emitter: LLVMEmitter) => llvm.Value;
  emit_proc: (emitter: LLVMEmitter, proc: Proc) => llvm.Value;
  emit_prog: (emitter: LLVMEmitter, prog: Prog) => llvm.Value;
  //emit_prog_variant: (emitter: LLVMEmitter, variant: Variant, prog: Prog) => llvm.Value;
  variant: Variant|null;
}

function emit_seq(emitter: LLVMEmitter, seq: ast.SeqNode, pred: (_: ast.ExpressionNode) => boolean = useful_pred): llvm.Value {
  if (pred(seq.lhs))
    emit(emitter, seq.lhs);
  return emit(emitter, seq.rhs);
}

function emit_let(emitter: LLVMEmitter, tree: ast.LetNode): llvm.Value {
  return assignment_helper(emitter, emit(emitter, tree.expr), tree.id!);
}

function emit_assign(emitter: LLVMEmitter, tree: ast.AssignNode, get_varsym=varsym): llvm.Value {
  let defid = emitter.ir.defuse[tree.id!];
  let extern = emitter.ir.externs[defid];

  if (extern !== undefined) {
    // Extern assignment.
    // TODO
    throw "not implemented yet";
  } else {
    // Ordinary variable assignment.
    return assignment_helper(emitter, emit(emitter, tree.expr), defid);
  }
}

function emit_lookup(emitter: LLVMEmitter, emit_extern: (name: string, type: Type) => llvm.Value, tree: ast.LookupNode, get_varsym=varsym): llvm.Value {
  let defid = emitter.ir.defuse[tree.id!];
  let name = emitter.ir.externs[defid];

  if (name !== undefined) {
    // extern
    let [type, _] = emitter.ir.type_table[tree.id!];
    return emit_extern(name, type);
  } else {
    // An ordinary variable lookup
    let id = varsym(defid);

    // look up the pointer
    if (emitter.named_values[defid] === undefined)
      throw "Unknown variable name (lookup)";
    let ptr: llvm.Value = emitter.named_values[defid];

    // load value
    return emitter.builder.buildLoad(ptr, id);
  }
}

function get_env_type(emitter: LLVMEmitter, scope: Scope): llvm.StructType {
  let free_types: llvm.Type[] = [];
  for (let id of scope.free) {
    free_types.push(llvm_type(emitter.ir.type_table[id][0]));
  }

  return llvm.StructType.create(free_types, true);
}

/* finds free variables, creates an environment, allocates space for the
 * environment on the stack, and then returns a pointer to that environment.
 * The pointer is of type [int8*], which abstracts away particular details
 * about free variables */
function pack_env(emitter: LLVMEmitter, scope: Scope): llvm.Value {

  // get values of free vars
  let free_vals: llvm.Value[] = [];
  for (let id of scope.free) {
    free_vals.push(emitter.builder.buildLoad(emitter.named_values[id], ""));
  }

  // build an environment structure that wraps around free vals
  let env_type = get_env_type(emitter, scope);
  var env_struct: llvm.Value = llvm.Value.getUndef(env_type);

  for (let i = 0; i < scope.free.length; i++) {
    env_struct = emitter.builder.buildInsertValue(env_struct, free_vals[i], i, "");
  }

  let env_struct_ptr: llvm.Value = emitter.builder.buildAlloca(env_type, "envptr");
  emitter.builder.buildStore(env_struct, env_struct_ptr);

  let hidden_env_type: llvm.Type = llvm.PointerType.create(llvm.IntType.int8(), 0);
  let env_ptr: llvm.Value = emitter.builder.buildBitCast(env_struct_ptr, hidden_env_type, "envptr_hidden");

  return env_ptr;
}

function pack_closure(emitter: LLVMEmitter, func: llvm.Function, scope: Scope): llvm.Value {
  let hidden_env_type: llvm.Type = llvm.PointerType.create(llvm.IntType.int8(), 0);
  let env_ptr = pack_env(emitter, scope);

  for (let p of scope.persist) {
    throw "persists not implemented yet"
  }

  var _func_type: [llvm.Type, llvm.Type[]]
  if ((<any>scope).params) {
    // it's a proc
    _func_type = get_func_type(emitter, scope.body.id!, (<any>scope).params);
  } else {
    // it's a prog
    _func_type = get_func_type(emitter, scope.body.id!, []);
  }
  let func_type: llvm.FunctionType = llvm.FunctionType.create(_func_type[0], _func_type[1]);

  let func_ptr_type: llvm.Type = llvm.PointerType.create(func_type, 0);
  let closure_type: llvm.Type = llvm.StructType.create([func_ptr_type, hidden_env_type] , true);
  var closure: llvm.Value = llvm.Value.getUndef(closure_type);
  closure = emitter.builder.buildInsertValue(closure, func, 0, "");
  closure = emitter.builder.buildInsertValue(closure, env_ptr, 1, "");
  return closure;
}

function emit_quote(emitter: LLVMEmitter, tree: ast.QuoteNode): llvm.Value {
  let func: llvm.Function = emitter.mod.getFunction(progsym(tree.id!));
  let prog: Prog = emitter.ir.progs[tree.id!];
  return pack_closure(emitter, func, prog);
}

function emit_func(emitter: LLVMEmitter, tree: ast.FunNode): llvm.Value {
  let func: llvm.Function = emitter.mod.getFunction(procsym(tree.id!));
  let proc: Proc = emitter.ir.procs[tree.id!];
  return pack_closure(emitter, func, proc);
}

/* unpacks a closure to returns a pair [func_ptr, env_ptr] */
function unpack_closure(emitter: LLVMEmitter, func_type: llvm.Type, closure: llvm.Value): [llvm.Value, llvm.Value] {
  let func_struct_ptr: llvm.Value = emitter.builder.buildAlloca(func_type, "");
  emitter.builder.buildStore(closure, func_struct_ptr);

  // get ptr to function inside function struct
  let func: llvm.Value = emitter.builder.buildLoad(emitter.builder.buildStructGEP(func_struct_ptr, 0, ""), "");

  // get pointer to environment inside function struct
  let env: llvm.Value = emitter.builder.buildLoad(emitter.builder.buildStructGEP(func_struct_ptr, 1, ""), "");

  return [func, env];
}

function emit_call(emitter: LLVMEmitter, tree: ast.CallNode): llvm.Value {
  // Get pointer to function struct
  let func_type = llvm_type(emitter.ir.type_table[tree.fun.id!][0]);
  let closure: llvm.Value = emit(emitter, tree.fun);
  if (!closure) throw "Unknown function";

  let [func, env] = unpack_closure(emitter, func_type, closure);

  // Turn args into llvm Values
  let llvm_args: llvm.Value[] = [];
  for (let arg of tree.args)
    llvm_args.push(emit(emitter, arg));
  llvm_args.push(env);

  // build function call
  return emitter.builder.buildCall(func, llvm_args, "calltmp");
}

function emit_run(emitter: LLVMEmitter, tree: ast.RunNode): llvm.Value {
  let func_type = llvm_type(emitter.ir.type_table[tree.expr.id!][0]);
  let closure: llvm.Value = emit(emitter, tree.expr);
  if (!closure) throw "Unknown function";

  let [func, env] = unpack_closure(emitter, func_type, closure);

  // Turn args into llvm Values
  let llvm_args: llvm.Value[] = [env];

  // build function call
  return emitter.builder.buildCall(func, llvm_args, "calltmp");
}

function emit_extern(name: string, type: Type): llvm.Value {
  if (is_fun_type(type)) {
    // The extern is a function. Wrap it in the clothing of our closure
    // format (with no environment).
    // TODO
    throw "not implemented"
  } else {
    // An ordinary value. Just look it up by name.
    // TODO
    throw "not implemented"
  }
}

// mostly a copy of emitter function
function emit(emitter: LLVMEmitter, tree: ast.SyntaxNode): llvm.Value {
  return emitter.emit_expr(tree, emitter);
}

function emit_fun(emitter: LLVMEmitter, name: string, arg_ids: number[], free_ids: number[], local_ids: number[], body: ast.ExpressionNode): llvm.Value {
  // create function
  let _func_type: [llvm.Type, llvm.Type[]] = get_func_type(emitter, body.id!, arg_ids);
  let func_type: llvm.FunctionType = llvm.FunctionType.create(_func_type[0], _func_type[1]);
  let func: llvm.Function = emitter.mod.addFunction(name, func_type);

  // create builder & entry block for func
  let bb: llvm.BasicBlock = func.appendBasicBlock("entry");
  let new_builder: llvm.Builder = llvm.Builder.create();
  new_builder.positionAtEnd(bb);

  // save old builder & reset
  let old_builder: llvm.Builder = emitter.builder;
  emitter.builder = new_builder;

  // save old namedValues map & reset
  let old_named_values: llvm.Value[] = emitter.named_values
  emitter.named_values = [];

  // make allocas for args
  for (let i = 0; i < arg_ids.length; i++) {
    // get arg id & type
    let id: number = arg_ids[i]
    let type:llvm.Type = _func_type[1][i];

    // create alloca
    let ptr: llvm.Value = emitter.builder.buildAlloca(type, varsym(id));
    emitter.builder.buildStore(func.getParam(i), ptr);
    emitter.named_values[id] = ptr;
  }

  // get environment struct type
  let free_types: llvm.Type[] = [];
  for (let id of free_ids) {
    let type: llvm.Type = llvm_type(emitter.ir.type_table[id][0]);
    free_types.push(type);
  }

  let env_ptr_type: llvm.Type = llvm.PointerType.create(llvm.StructType.create(free_types, true), 0);

  // get ptr to environment struct
  let env_ptr_uncasted: llvm.Value = func.getParam(arg_ids.length);
  let env_ptr: llvm.Value = emitter.builder.buildBitCast(env_ptr_uncasted, env_ptr_type, "");

  for (let i = 0; i < free_ids.length; i++) {
    // get id and type
    let id: number = free_ids[i];
    let type: llvm.Type = free_types[i];

    // build alloca
    let ptr: llvm.Value = emitter.builder.buildAlloca(type, varsym(id));

    // get the element in the struct that we want
    let struct_elem_ptr: llvm.Value = emitter.builder.buildStructGEP(env_ptr, i, "");
    let elem: llvm.Value = emitter.builder.buildLoad(struct_elem_ptr, "");

    // store the element in the alloca
    emitter.builder.buildStore(elem, ptr);
    emitter.named_values[id] = ptr;
  }

  // make allocas for local vars
  for (let id of local_ids) {
    // get type
    let type: llvm.Type = llvm_type(emitter.ir.type_table[id][0]);

    // create alloca
    let ptr: llvm.Value = emitter.builder.buildAlloca(type, varsym(id));
    emitter.named_values[id] = ptr;
  }

  // generate body
  let body_val: llvm.Value = emit(emitter, body);
  emitter.builder.ret(body_val);

  // reset saved things
  emitter.builder.free();
  emitter.builder = old_builder;
  emitter.named_values = old_named_values;

  return func;
}

/**
 * Get the current specialized version of a function.
 */
export function specialized_proc(emitter: LLVMEmitter, procid: number) {
  let variant = emitter.variant;
  if (!variant) {
    return emitter.ir.procs[procid];
  }
  return variant.procs[procid] || emitter.ir.procs[procid];
}

export function specialized_prog(emitter: LLVMEmitter, progid: number) {
  let variant = emitter.variant;
  if (!variant) {
    return emitter.ir.progs[progid];
  }
  return variant.progs[progid] || emitter.ir.progs[progid];
}

/*
 * Emit either kind of scope
 */
function emit_scope(emitter: LLVMEmitter, scope: number) {
  // Try a Proc.
  let proc = specialized_proc(emitter, scope);
  if (proc) {
    return emitter.emit_proc(emitter, proc);
  }

  // It must be a Prog.
  let prog = specialized_prog(emitter, scope);
  if (prog) {
    return emitter.emit_prog(emitter, prog);
  }

  throw `scope id ${scope} not found`;
}

// Compile all the Procs and progs who are children of a given scope.
function _emit_subscopes(emitter: LLVMEmitter, scope: Scope): void {
  for (let id of scope.children) {
    emit_scope(emitter, id);
  }
}

// Get all the names of bound variables in a scope.
// In Python: [varsym(id) for id in scope.bound]
function _bound_vars(scope: Scope): number[] {
  let names: number[] = [];
  for (let bv of scope.bound) {
    names.push(bv);
  }
  return names;
}

function _emit_scope_func(emitter: LLVMEmitter, name: string, arg_ids: number[], free_ids: number[], scope: Scope): llvm.Value {
  _emit_subscopes(emitter, scope);

  let local_ids = _bound_vars(scope);
  let func = emit_fun(emitter, name, arg_ids, free_ids, local_ids, scope.body);
  return func;
}

function emit_proc(emitter: LLVMEmitter, proc: Proc): llvm.Value {
  // The arguments consist of the actual parameters, the closure environment
  // (free variables), and the persists used inside the function.
  let arg_ids: number[] = [];
  let free_ids: number[] = [];
  for (let param of proc.params) {
    arg_ids.push(param);
  }
  for (let fv of proc.free) {
    free_ids.push(fv);
  }
  for (let p of proc.persist) {
    throw "Persist not implemented yet";
  }

  // Get the name of the function, or null for the main function.
  let name: string;
  if (proc.id === null) {
    name = 'main';
  } else {
    name = procsym(proc.id);
  }

  return _emit_scope_func(emitter, name, arg_ids, free_ids, proc);
}

function emit_prog(emitter: LLVMEmitter, prog: Prog): llvm.Value {
  // The arguments consist of the closure environment and the persisted
  // variables used inside the prog
  let arg_ids: number[] = [];
  let free_ids: number[] = [];

  for (let param of prog.owned_persist) {
    free_ids.push(param.id);
  }

  for (let fv of prog.free) {
    free_ids.push(fv);
  }

  for (let p of prog.persist) {
    console.log(p);
  }

  // Get the name of the function, or null for the main function.
  let name: string = progsym(prog.id!);

  return _emit_scope_func(emitter, name, arg_ids, free_ids, prog);

}

function emit_prog_variant() {

}

///////////////////////////////////////////////////////////////////
// End Emit Functions & Redundant Funcs
///////////////////////////////////////////////////////////////////

/**
 * Get the LLVM type represented by a Braid type.
 */
function llvm_type(type: Type): llvm.Type {

  if (type === INT) {
    return llvm.IntType.int32();
  } else if (type === FLOAT) {
    return llvm.FloatType.double();
  } else if (type instanceof FunType) {
    // get types of args and return value
    let arg_types: llvm.Type[] = [];
    for (let arg of type.params) {
      arg_types.push(llvm_type(arg));
    }
    arg_types.push(llvm.PointerType.create(llvm.IntType.int8(), 0));
    let ret_type: llvm.Type = llvm_type(type.ret);

    // construct appropriate func type & wrap in ptr
    let func_type: llvm.FunctionType = llvm.FunctionType.create(ret_type, arg_types);
    let func_type_ptr: llvm.PointerType = llvm.PointerType.create(func_type, 0);

    // create struct environment: {function, closure environment}
    let struct_type: llvm.StructType = llvm.StructType.create([func_type_ptr, llvm.PointerType.create(llvm.IntType.int8(), 0)], true);
    return struct_type;
  } else if (type instanceof CodeType) {
    let arg_types: llvm.Type[] = [llvm.PointerType.create(llvm.IntType.int8(), 0)];
    let ret_type: llvm.Type = llvm_type(type.inner);

    // construct appropriate func type & wrap in ptr
    let func_type: llvm.FunctionType = llvm.FunctionType.create(ret_type, arg_types);
    let func_type_ptr: llvm.PointerType = llvm.PointerType.create(func_type, 0);

    // create struct environment: {function, closure environment}
    let struct_type: llvm.StructType = llvm.StructType.create([func_type_ptr, llvm.PointerType.create(llvm.IntType.int8(), 0)], true);
    return struct_type;
  } else {
    throw "Unsupported type in LLVM backend: " + type;
  }
}

/**
 * Get return type and arg types of function. Returns [return type, array of arg types]
 */
function get_func_type(emitter: LLVMEmitter, ret_id: number, arg_ids: number[]): [llvm.Type, llvm.Type[]] {
  let ret_type: llvm.Type = llvm_type(emitter.ir.type_table[ret_id][0]);
  let arg_types: llvm.Type[] = [];
  for (let id of arg_ids) {
    arg_types.push(llvm_type(emitter.ir.type_table[id][0]));
  }
  arg_types.push(llvm.PointerType.create(llvm.IntType.int8(), 0)); // closure environment struct ptr

  return [ret_type, arg_types];
}

let ptr_t: llvm.Type = llvm.PointerType.create(llvm.IntType.int8(), 0);
let int_t: llvm.Type = llvm.IntType.int32();
let void_t: llvm.Type = llvm.VoidType.create();

/**                           name     return        args */
const runtime_declarations: [string, llvm.Type, llvm.Type[]][] =
[
  ["mesh_indices", int_t, [ptr_t]],
  ["mesh_positions", int_t, [ptr_t]],
  ["mesh_normals", int_t, [ptr_t]],
  ["get_shader", int_t, [ptr_t, ptr_t]],
  ["draw_mesh", void_t, [int_t, int_t]],
  ["print_mesh", void_t, [ptr_t]],
  ["gl_buffer", int_t, [int_t, ptr_t, ptr_t]],
  ["detect_error", void_t, []],
  ["load_obj", ptr_t, [ptr_t, ptr_t]],
  ["create_window", ptr_t, []]
];

function emit_runtime_declaration(emitter: LLVMEmitter) {
  for (let [name, ret_type, arg_types] of runtime_declarations) {
    let func_type = llvm.FunctionType.create(ret_type, arg_types);

    /* although calls to runtime functions don't take an environment pointer,
     * we wrap them so that they do (in order to have consistent function
     * calling semantics) */
    let dummy_args: llvm.Type[] = [];
    for (let t of arg_types) {
      dummy_args.push(t);
    }
    // environment ptr is last argument
    dummy_args.push(ptr_t);

    let dummy_func_type = llvm.FunctionType.create(ret_type, dummy_args);
    let actual_func_type = llvm.FunctionType.create(ret_type, arg_types);
    // declare actual runtime function
    let decl_func = emitter.mod.getOrInsertFunction(name, actual_func_type);
    // emit wrapper
    let wrapper_func = emitter.mod.addFunction(name + "_wrapper", dummy_func_type);
    let bb: llvm.BasicBlock = wrapper_func.appendBasicBlock("entry");
    let new_builder: llvm.Builder = llvm.Builder.create();
    new_builder.positionAtEnd(bb);

    /* generate code for the wrapper: first make space for args on the stack
     * and then call the declared runtime function */

    let pass_on_args: llvm.Value[] = [];
    for (let i = 0; i < dummy_args.length - 1; i++) {
      pass_on_args[i] = wrapper_func.getParam(i);
      /*
      let arg_t = dummy_args[i];
      let ptr = new_builder.buildAlloca(arg_t, "arg");
      new_builder.buildStore(wrapper_func.getParam(i), ptr);
      allocas.push(ptr);
      */
    }

    let call = new_builder.buildCall(decl_func, pass_on_args, "");
    if (ret_type != void_t) {
      new_builder.ret(call);
    } else {
      llvm.LLVM.LLVMBuildRetVoid(new_builder.ref);
    }
  }
}

/**
 * Store a val in the ptr location to which emitter maps the provided id
 */
function assignment_helper(emitter: LLVMEmitter, val: llvm.Value, id: number): llvm.Value {
  // get pointer to stack location
  if (emitter.named_values[id] === undefined)
    throw "Unknown variable name (assign helper)";
  let ptr: llvm.Value = emitter.named_values[id];

  // store new value and return this value
  emitter.builder.buildStore(val, ptr);
  return val;
}

/**
 * Core recursive compile rules
 */
export let compile_rules: ASTVisit<LLVMEmitter, llvm.Value> = {

  visit_alloc(tree: ast.AllocNode, emitter: LLVMEmitter): llvm.Value {
    // TODO
    return llvm.ConstInt.create(0, llvm.IntType.int32());
  },

  visit_tupleind(tree: ast.TupleIndexNode, emitter: LLVMEmitter): llvm.Value {
    // TODO
    return llvm.ConstInt.create(0, llvm.IntType.int32());
  },

  visit_tuple(tree: ast.TupleNode, emitter: LLVMEmitter): llvm.Value {
    // TODO
    return llvm.ConstInt.create(0, llvm.IntType.int32());
  },

  visit_root(tree: ast.RootNode, emitter: LLVMEmitter): llvm.Value {
    emit_runtime_declaration(emitter);
    return emit(emitter, tree.children[0]);
  },

  visit_typealias(tree: ast.TypeAliasNode, emitter: LLVMEmitter): llvm.Value {
    // TODO
    return llvm.ConstInt.create(0, llvm.IntType.int32());
  },

  visit_literal(tree: ast.LiteralNode, emitter: LLVMEmitter): llvm.Value {
    if (tree.type === "int") {
      return llvm.ConstInt.create(<number>tree.value, llvm.IntType.int32());
    }
    else if (tree.type === "float")
      return llvm.ConstFloat.create(<number>tree.value, llvm.FloatType.double());
    else if (tree.type === "string")
      return llvm.ConstString.create(<string>tree.value, false);
    else
      throw "Unrecognized Type";
  },

  visit_seq(tree: ast.SeqNode, emitter: LLVMEmitter): llvm.Value {
    return emit_seq(emitter, tree);
  },

  visit_let(tree: ast.LetNode, emitter: LLVMEmitter): llvm.Value {
    return emit_let(emitter, tree);
  },

  visit_assign(tree: ast.AssignNode, emitter: LLVMEmitter): llvm.Value {
    return emit_assign(emitter, tree);
  },

  visit_lookup(tree: ast.LookupNode, emitter: LLVMEmitter): llvm.Value {
    return emit_lookup(emitter, emit_extern, tree);
  },

  visit_unary(tree: ast.UnaryNode, emitter: LLVMEmitter): llvm.Value {
    let val: llvm.Value = emit(emitter, tree.expr)
    let [type, _] = emitter.ir.type_table[tree.expr.id!];

    if (type === INT) {
      if (tree.op === "-")
        return emitter.builder.neg(val, "negtmp");
      else
        throw "Unknown unary op"
    } else if (type === FLOAT) {
      if (tree.op === "-")
        return emitter.builder.negf(val, "negtmp");
      else
        throw "Unknown unary op"
    } else {
      throw "Incompatible Operand"
    }
  },

  visit_binary(tree: ast.BinaryNode, emitter: LLVMEmitter): llvm.Value {
    let lVal: llvm.Value = emit(emitter, tree.lhs);
    let rVal: llvm.Value = emit(emitter, tree.rhs);

    let [lType, _1] = emitter.ir.type_table[tree.lhs.id!];
    let [rType, _2] = emitter.ir.type_table[tree.rhs.id!];

    if (lType === INT && rType === INT) {
      // both operands are ints, so do integer operation
      switch (tree.op) {
        case "+": {
          return emitter.builder.add(lVal, rVal, "addtmp");
        }
        case "*": {
          return emitter.builder.mul(lVal, rVal, "multmp");
        }
        default: {
          throw "Unknown bin op";
        }
      }
    } else if ((lType !== FLOAT && lType !== INT) || (rType !== FLOAT && rType !== INT)) {
      // at least one operand is neither an int nor a float, so throw error
      throw "Incompatible Operands";
    } else {
      // at least one operand is a float, and the other is either a float or an int
      // perform casts if needed, and us float operation
      if (lType !== FLOAT)
        lVal = emitter.builder.buildSIToFP(lVal, llvm.FloatType.double(), "lCast");
      if (rType !== FLOAT)
        rVal = emitter.builder.buildSIToFP(rVal, llvm.FloatType.double(), "lCast");

      switch (tree.op) {
        case "+": {
          return emitter.builder.addf(lVal, rVal, "addtmp");
        }
        case "*": {
          return emitter.builder.mulf(lVal, rVal, "multmp");
        }
        default: {
          throw "Unknown bin op";
        }
      }
    }
  },

  visit_quote(tree: ast.QuoteNode, emitter: LLVMEmitter): llvm.Value {
    return emit_quote(emitter, tree);
  },

  visit_escape(tree: ast.EscapeNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit escape not implemented";
  },

  visit_run(tree: ast.RunNode, emitter: LLVMEmitter): llvm.Value {
    return emit_run(emitter, tree);
  },

  visit_fun(tree: ast.FunNode, emitter: LLVMEmitter): llvm.Value {
    return emit_func(emitter, tree);
  },

  visit_call(tree: ast.CallNode, emitter: LLVMEmitter): llvm.Value {
    return emit_call(emitter, tree);
  },

  visit_extern(tree: ast.ExternNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit extern not implemented";
  },

  visit_persist(tree: ast.PersistNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit persist not implemented";
  },

  visit_if(tree: ast.IfNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit if not implemented";
  },

  visit_while(tree: ast.WhileNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit while not implemented";
  },

  visit_macrocall(tree: ast.MacroCallNode, emitter: LLVMEmitter): llvm.Value {
    throw "visit macrocall not implemented";
  }
};

/**
 * Compile the IR to an LLVM module.
 */
export function codegen(ir: CompilerIR): llvm.Module {
  llvm.initX86Target();
  // Set up the emitter, which includes the LLVM IR builder.
  let builder = llvm.Builder.create();
  // Create a module. This is where all the generated code will go.
  let mod: llvm.Module = llvm.Module.create("braidprogram");

  let target_triple: string = llvm.TargetMachine.getDefaultTargetTriple();
  let target = llvm.Target.getFromTriple(target_triple);
  let target_machine = llvm.TargetMachine.create(target, target_triple);
  let data_layout = target_machine.createDataLayout().toString();

  mod.setDataLayout(data_layout);
  mod.setTarget(target_triple);

  let emitter: LLVMEmitter = {
    ir: ir,
    mod: mod,
    builder: builder,
    named_values: [],
    emit_expr: (tree: ast.SyntaxNode, emitter: LLVMEmitter) => ast_visit(compile_rules, tree, emitter),
    emit_proc: emit_proc,
    emit_prog: emit_prog,
    //emit_prog_variant: emit_prog_variant,
    variant: null,
  };

  // Generate the main function into the module.
  emit_main(emitter);

  // Now that we're done generating code, we can free the IR builder.
  emitter.builder.free();

  return emitter.mod;
}

/**
 * Emit the main function (and all the functions it depends on, eventually)
 * into the specified LLVM module.
 */
function emit_main(emitter: LLVMEmitter): llvm.Value {
  return emit_proc(emitter, emitter.ir.main);
}
