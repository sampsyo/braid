// The kinds of types.
type Type = PrimitiveType | FunType | CodeType | AnyType | VoidType |
  ParameterizedType | InstanceType;

// Primitive types are singular instances.
class PrimitiveType {
  constructor(public name: string) {};

  // A workaround to compensate for TypeScript's structural subtyping:
  // https://github.com/Microsoft/TypeScript/issues/202
  _brand_PrimitiveType: void;
};

// Simple top and bottom types.
class AnyType {
  _brand_AnyType: void;
};
class VoidType {
  _brand_AnyType: void;
};
const ANY = new AnyType();
const VOID = new VoidType();

// Function types are more complicated. Really wishing for ADTs here.
class FunType {
  constructor(public params: Type[], public ret: Type) {};
  _nominal_FunType: void;
};

// Same with code types.
class CodeType {
  constructor(public inner: Type) {};
  _nominal_CodeType: void;
};

// Type maps are used all over the place: most urgently, as "frames" in the
// type checker's environment.
interface TypeMap {
  [name: string]: Type;
}

// The built-in primitive types.
const INT = new PrimitiveType("Int");
const FLOAT = new PrimitiveType("Float");
const BUILTIN_TYPES: TypeMap = {
  "Int": INT,
  "Float": FLOAT,
};

// A parameterized type is just a type-level function.
class ParameterizedType {
  constructor(public name: String) {};
  instance(arg: Type) {
    return new InstanceType(this, arg);
  };
}
class InstanceType {
  constructor(public cons: ParameterizedType, public arg: Type) {};
}
