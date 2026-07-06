declare module 'json-logic-js' {
  const jsonLogic: {
    apply: (rule: any, data?: any) => any;
    add_operation: (name: string, fn: (...args: any[]) => any) => void;
  };
  export default jsonLogic;
}
