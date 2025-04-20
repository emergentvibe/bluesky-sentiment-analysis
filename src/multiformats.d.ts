declare module 'multiformats/cid' {
  // Declare CID as a class (or interface if more appropriate)
  // We don't need all its methods/properties defined for basic type checking,
  // just letting TS know it's a construct that can be used as a type.
  export class CID {
    // Optionally add known properties/methods if needed elsewhere, e.g.:
    // readonly version: number;
    // readonly code: number;
    // readonly multihash: any;
    // toString(): string;
    // equals(other: any): boolean;
    // constructor(...args: any[]); // Add constructor signature if known/needed
  }
} 