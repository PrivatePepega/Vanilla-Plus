"use client";




// Contracts


import { useReadContract } from "thirdweb/react";
import { useActiveAccount } from "thirdweb/react";
import { gameContractSourceDAO, gameContractMoneyDAO } from "@/utils/functionDump/getContracts"
import { useSendTransaction } from "thirdweb/react";

import { prepareContractCall } from "thirdweb";

import { ButtonGroup, Button, Input } from "@material-tailwind/react";
import WoWUpload from "@/components/wowFileUpload";




const Mint = () => {












    const { mutate: DAONoMint, isPending: DAONoMintpending } = useSendTransaction();
    const handleDAONoMint = async () => {
      const punishDAOTX = prepareContractCall({
        contract: gameContractSourceDAO,
        method: "function NoMintPunishment()",
      });
      DAONoMint(punishDAOTX);
    };
    
    const { data: daoAmount, isLoading: daoAmountLoading } = useReadContract({
      contract: gameContractSourceDAO,
      method: "function amountPerMint() returns (uint256)",
    });








  

    const { mutate: MoneyNoMint, isPending: MoneyNoMintpending } = useSendTransaction();
    const handleMoneyNoMint = async () => {
      const punishMoneyTX = prepareContractCall({
        contract: gameContractMoneyDAO,
        method: "function NoMintPunishment()",
      });
      MoneyNoMint(punishMoneyTX);
    };

    const { data: moneyAmount, isLoading: moneyAmountLoading } = useReadContract({
      contract: gameContractMoneyDAO,
      method: "function amountPerMint() returns (uint256)",
    });






    





    return (
      <div className='flex flex-col justify-center items-center w-full'>

      <div className="flex flex-row gap-8">

        <div className="flex flex-col justify-center items-center">
          <h2>source: ({Number(daoAmount)})</h2>
          <ButtonGroup>
            <Button onClick={()=> {handleDAONoMint()}}>punish</Button>
          </ButtonGroup>
        </div>


        <div className="flex flex-col justify-center items-center">
          <h2>money: ({Number(moneyAmount)})</h2>
          <ButtonGroup>
            <Button onClick={()=> {handleMoneyNoMint()}}>punish</Button>
          </ButtonGroup>
        </div>


      </div>





      <WoWUpload/>
        
      </div>
    )

  
}


export default Mint
